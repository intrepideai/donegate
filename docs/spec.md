# The DONE.md spec

**Version 1** · Status: stable

`DONE.md` is a file at the root of a repository that declares the repository's
**definition of done** in a form that is both human-readable and
machine-enforceable. It is the third file in a lineage:

| file | audience | answers |
|---|---|---|
| `README.md` | humans | *what is this?* |
| `AGENTS.md` | agents | *how do I work here?* |
| `DONE.md` | the gate | *when am I allowed to say I'm finished?* |

A repository with a DONE.md is making a statement: **"done" is not a feeling
here — it's an exit code.**

## File format

DONE.md is markdown. Tools read the **first fenced `yaml` code block** in the
file; everything else is prose for humans and agents. A repo may instead use a
plain `done.yml`, `done.yaml`, or `.donegate/done.yml` (same schema, no
markdown wrapper). Discovery walks upward from the working directory and stops
at the first file found, in that priority order.

## Schema

```yaml
version: 1            # optional, defaults to 1

checks:               # required, at least one
  - name: tests       # required — unique identifier
    run: npm test     # required — shell command; exit 0 = pass
    timeout: 600      # optional — seconds (default 600, max 3600)

guards:               # optional — tamper detection levels
  no_done_edits: true        # DONE.md modified mid-session
  no_deleted_tests: true     # test files deleted / test counts dropped
  no_new_skips: true         # .skip/.only/xfail/t.Skip/#[ignore] added
  no_disabled_lint: true     # eslint-disable/noqa/@ts-ignore/nolint added
  no_new_todos: warn         # TODO/FIXME/HACK introduced
  no_debug_artifacts: warn   # console.log/debugger/pdb.set_trace left behind
  no_protected_edits: true   # files matching `protect` changed mid-session
  test_globs:                # optional — what counts as a test file
    ["**/*.test.*", "**/*.spec.*", "**/test_*.py", "**/*_test.go", "..."]
  exclude: []                # optional — files exempt from guard analysis
                             # (for code that legitimately CONTAINS the
                             # patterns: lint configs, scanners, donegate itself)
  protect: []                # optional — globs for files the verdict depends on
                             # but the gate doesn't run: the files that define
                             # what the check commands MEAN (package.json,
                             # eslint/jest/pytest/tsconfig configs). Hashed into
                             # the baseline; any change, deletion, or new
                             # shadowing file trips no_protected_edits.

gate:                 # optional
  max_bounces: 3      # consecutive no-progress stop-hook re-prompts per
                      # session before giving up (1-20); progress — a strictly
                      # lower failing-check + tripped-guard count than the
                      # session's best — refreshes the budget
```

Guard levels: `true` (findings fail the gate), `"warn"` (findings are reported
but don't fail), `false` (guard off). `"fail"`/`"off"` are accepted aliases.

The YAML dialect is deliberately small: maps, sequences, scalars, comments,
block scalars, and inline scalar lists. No anchors, tags, or flow maps —
parsers must reject what they don't understand rather than guess.

## Semantics

### Checks

Checks are shell commands run sequentially from the DONE.md directory, each
with combined output captured and a timeout. **The repo owner writes the
commands; the gate never invents or modifies them.** A check passes iff its
exit code is 0.

### Guards

Guards answer a different question than checks. Checks ask *"does the work
pass?"* Guards ask ***"was the bar lowered so it would pass?"*** They compare
the current tree against a **baseline**:

1. a **session baseline** recorded when an agent session starts (test-file
   hashes, test/skip counts, hashes of `guards.protect` files, the DONE.md
   hash, and the git HEAD at that moment), or
2. **HEAD**, when there's uncommitted work and no session baseline, or
3. the **merge-base with the default branch**, for clean trees (the CI case).

An **explicit ref** (`donegate check --against <ref>`) overrides all three,
including the session baseline: judge mode evaluates a diff, not a session.
The verdict is then derivable from git history alone — useful for grading
fan-out worktrees from a workflow script, pinning CI to the PR base, or
re-deriving a verdict past a re-blessed baseline.

All guard findings are deterministic, diff-based, and cite `file:line`
evidence. Guards never call a model and never make network requests.

### Verdict and exit codes

| code | meaning |
|---|---|
| 0 | done — every check passed, no guard at fail level tripped |
| 1 | one or more checks failed |
| 2 | configuration or usage error |
| 3 | checks passed, but a guard tripped — the work was *made* to look done |

Exit code 3 exists on purpose: it's the difference between *not finished* and
*gamed*, and CI may want to treat them differently (e.g. ping a human on 3).

### Receipts

Every gate run writes a **receipt** (`.donegate/receipts/latest.json`, plus a
rolling history): the verdict, every check's command/exit/duration/output tail,
every guard's findings, the baseline used, a diffstat, repo state (HEAD,
branch, dirty), and a sha256 of the receipt body. The receipt — not the agent's
final message — is the artifact you trust. `.donegate/` is local state and
belongs in `.gitignore`.

### Stop-hook behavior

When wired into an agent's stop hook, the gate runs at the moment the agent
tries to finish:

- **fail** → the stop is blocked and the failure report (failing commands,
  output tails, guard findings with file:line) is fed back to the agent, which
  keeps working. Each block increments a per-session **bounce counter**.
- **pass** → the stop proceeds; the bounce counter resets; the receipt is green.
- **progress** → a stop attempt whose failure count (failing checks + tripped
  guards) is strictly below the session's best **refreshes the bounce budget**:
  an agent steadily working down a list is never cut off mid-fix. Best-ever is
  the bar, so alternating between failure sets cannot farm refreshes.
- **bounces exhausted** (`gate.max_bounces` consecutive attempts without new
  progress) → the gate stops *blocking* but never stops *verifying*: the stop
  is allowed with a loud warning and a red receipt. The gate must not be able
  to trap an agent in an infinite loop.
- a repo **without** a DONE.md → the hook is a silent no-op. A **broken**
  DONE.md → warn and allow (a config typo must never wedge an agent).
- user-initiated aborts are never blocked.

## Design principles

1. **Deterministic.** The gate re-runs the repo's own commands and diffs the
   repo's own files. Same tree, same verdict — on any machine.
2. **The gate is not the agent's to edit.** DONE.md is owned by humans;
   modifying it mid-session is itself a finding.
3. **Fail open on infrastructure, fail closed on work.** Broken config or
   missing tooling must never trap an agent or block a stop forever; failing
   tests must never be talked past.
4. **Evidence over assertion.** Every red verdict points at commands, exit
   codes, and `file:line` findings — never "the model thinks it's incomplete."
