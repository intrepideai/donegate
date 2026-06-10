# Threat model

donegate gates an agent **from inside the agent's own sandbox**. The hook
config, the baseline, the bounce state — even donegate's installed code — all
live in files the agent could touch. That makes the design question precise:
which cheats does the gate make *impossible*, which does it make *loud and
expensive*, and which does it merely leave evidence of? This page is the
honest map.

## What the gate catches outright

Deterministic, diff-based, with `file:line` receipts:

| move | what happens |
|---|---|
| stop while checks fail | bounced, failure output fed back into context |
| `.skip` / `.only` / `xfail` / `t.Skip()` / `#[ignore]` added | `no_new_skips` → exit 3 |
| test file deleted, or a per-file test count dropping | `no_deleted_tests` → exit 3 |
| `eslint-disable` / `@ts-ignore` / `# noqa` / `//nolint` added | `no_disabled_lint` → exit 3 |
| DONE.md edited mid-session | `no_done_edits` → exit 3 |
| DONE.md **deleted** mid-session | stop bounced — the baseline remembers it existed |
| DONE.md **broken** mid-session (no longer parses) | stop bounced — its hash no longer matches the baseline |

Exit 3 — *"checks pass but the bar was lowered to get there"* — is
deliberately a distinct, alarmable signal.

## What the gate cannot catch (and won't pretend to)

These are out of reach for any deterministic, no-LLM gate, and you should know
that rather than guess it:

- **Semantic cheats inside the tests.** Weakening an assertion
  (`expect(total).toBe(total)`), gutting a test body while keeping its name,
  deleting a hard test and adding a trivial one in the same file (the per-file
  count stays flat), updating snapshots to bake a bug in, or writing both the
  bug and the test that blesses it. Catching these means judging *meaning*; a
  diff and a regex can't, and donegate refuses to guess.
- **Command indirection.** DONE.md is hash-guarded, but `run: npm test`
  resolves through package.json — and package.json, jest.config, pytest.ini,
  tsconfig, and the linter config are all agent-editable. `"test": "exit 0"`
  is green. Mitigations: prefer direct invocations in your checks
  (`npx vitest run` rather than `npm test`) and treat tooling-config diffs as
  review-worthy, because they are.
- **Attacks on donegate's own state.** An agent with shell access can run
  `donegate baseline` to bless its own donefile edit, hand-edit
  `.donegate/state.json` to burn the bounce budget, or patch
  `node_modules/donegate` itself. Local hooks raise the cost of cheating and
  leave a trail; they are not a security boundary.

## Where the boundary actually is

The copy of the gate an agent can't touch is the one that runs **outside its
sandbox**:

1. **`donegate install ci`** — the same DONE.md, the same guards, evaluated
   against the merge-base on a runner the agent never sees. A deleted DONE.md
   is a config error there (exit 2), not a no-op.
2. **Branch protection** — make the donegate job a required check, so "merge
   anyway" isn't on the table.
3. **Receipts in review** — the CI install posts the receipt (guard findings
   included) as a PR comment, so a lowered bar is visible to the humans who
   own the bar.

Local hooks are the fast loop: catch it while the agent still has the context
to fix it. CI is the slow loop: catch whatever survived. The combination is
the design — neither alone is.

## Design choices worth knowing

- **Bounded blocking, always.** Every blocking path has a bounce budget
  (`gate.max_bounces`, default 3 — the default also applies when the donefile
  is missing or unreadable, since its config is too). After that the stop is
  allowed with a loud red note, and the receipt stays honest. A gate that can
  hold a session hostage is worse than a gate that can be outlasted.
- **Fail open on infrastructure, fail closed on work.** A donefile that was
  already broken *before* the session (no baseline, or hash unchanged since
  it) warns and allows — donegate won't trap an agent in a problem it didn't
  cause. A donefile that broke *during* the session is treated as work, not
  infrastructure: bounced.
- **Receipts are evidence, not proof.** They're plain JSON written by whatever
  ran the gate, not cryptographically signed artifacts. The local ones are for
  fast feedback and honest retrospectives; the ones CI writes and posts are
  the ones to trust.
