# donegate in agent loops

Coding agents run a loop: gather context → take action → verify → repeat.
Increasingly that loop fans out — orchestrators spawn subagents, subagents get
their own worktrees, workflow scripts coordinate the lot. donegate has a
specific seat at three points of that topology, and this page maps them.

## The three seats

| where | mechanism | what runs | cost |
|---|---|---|---|
| **terminal stop** | `Stop` hook | full gate: checks + guards | your test suite |
| **subagent boundary** | `SubagentStop` hook (`hook claude --subagent`) | guards only | git diffs + regexes — fast |
| **judge in a fan-out** | `donegate check --against <ref> --json` | checks + guards vs an explicit ref | your call (use `--only` to scope) |

### Terminal stop — the gate on the loop's exit

The classic donegate role: the agent tries to finish, the gate runs the
repo's definition of done, failure bounces the agent back with the report in
its context. This is the **deterministic verifier** in the loop's
verify-work phase — exit codes and diffs, no LLM judging anything, which also
means it can't share an LLM judge's self-preference for the code that was
just written.

### Subagent boundary — tamper scan per node

A full test suite per subagent would be brutal; a tamper scan isn't. The
`SubagentStop` hook (installed automatically by `donegate install claude`)
runs **guards only**: did this subagent skip or delete tests, silence the
linter, touch a protected file, edit the donefile? Findings block the
subagent's completion the same way the stop hook blocks the session — the
finding lands while the subagent still has the context to undo it, instead of
surfacing at the terminal stop after its output was already absorbed.

Read-only subagents (searchers, reviewers) change nothing, trip nothing, and
pay one git diff. Subagent bounces are tracked in their own ledger
(`<session>:subagent`), so a noisy fan-out can't burn the bounce budget the
terminal gate relies on.

### Judge mode — `--against` in workflow scripts

Fan-out patterns end with verification: N agents produced N diffs, something
deterministic should grade them before anything merges. `--against` pins the
comparison to an explicit ref — the worktree's fork point, the PR base —
instead of whatever baseline/merge-base resolution would guess. With `--json`
the receipt is machine-readable; the exit code is the verdict
(0 done / 1 checks failed / 3 bar was lowered).

```js
// inside a workflow script: judge each worktree before accepting it
const verdict = await bash(
  `cd ${worktree} && npx -y donegate check --against ${forkPoint} --json --quiet`,
);
// exit 0 → accept; exit 3 → the diff "passes" because the bar moved — reject loudly
```

`--against` deliberately **ignores the session baseline** — judge mode judges
a diff, not a session. That also makes it the answer to a re-blessed
baseline: `donegate check --against origin/main` re-derives the verdict from
git history alone.

## Worktree behavior

Linked worktrees get their own `.donegate/` (it's per-root and gitignored).
Inside a fresh worktree there is usually **no session baseline**, so guards
fall back to git comparisons — added-line scans against HEAD or merge-base
still work; baseline-only detections (count drops in untouched files,
protected-file hashes) degrade gracefully. For full-strength guards in a
worktree, record a baseline when it's created (`donegate baseline`) or judge
it from outside with `--against <fork point>`.

## Loop-until-done, bounded

A fixed bounce cap fights the loop: an agent steadily fixing a long failure
list gets cut off mid-fix. donegate's budget counts **consecutive bounces
without new progress** — when a stop attempt's failure count (failing checks +
tripped guards) drops below the session's best, the budget refreshes and the
agent is told so. "Best ever" is the bar, not "better than last time," so
oscillating between two failure sets can't farm refreshes; total bounces stay
bounded and a wedged session still exits with a red receipt.

## What this does not change

The loop's failure modes that donegate addresses are the *mechanical* ones:
declaring done early (agentic laziness that trips a check), lowering the bar
to get green (guards), drifting past the definition of done (DONE.md is
re-read from disk every stop — compaction can't summarize it away). The
*semantic* failure modes — weakened assertions, vacuous tests, an agent
grading its own homework — still need a clean-context reviewer or a human;
see [threat-model.md](threat-model.md) for the honest boundary.
