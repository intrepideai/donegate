# Changelog

## Unreleased

- **The donefile can no longer be deleted or broken out of the way.** The stop
  hook used to treat a missing DONE.md as "not my repo" and an unparseable one
  as a config typo — both fail-open, both one `rm` or one bad edit away from
  disarming the gate mid-session. Now, when the session baseline records a
  donefile that has since vanished or stopped matching, the stop is bounced
  with restore instructions instead (bounded by the default bounce budget).
  Repos that never opted in are still silent no-ops, and a donefile that was
  already broken before the session started still fails open — a config typo
  must never trap an agent that didn't cause it.
- `docs/threat-model.md` — an honest map of what the gate catches, what it
  deliberately doesn't (semantic cheats, command indirection, attacks on
  donegate's own state), and why CI + branch protection is the actual boundary.

## 0.1.0

Initial release.

- `DONE.md` — a machine-enforceable definition of done that lives in your repo
- `donegate init` — stack autodetection (node/pnpm/yarn/bun, python/uv/poetry,
  go, rust, ruby, gradle/maven, .NET, elixir, php, swift, deno, make/just) and
  DONE.md scaffolding
- `donegate status` — one-screen view of donefile, baseline, installed hooks,
  CI, and the last receipt
- `donegate check` — runs every check, runs the tamper guards, writes a receipt
  (exit codes: 0 done, 1 checks failed, 2 config error, 3 guards tripped)
- Tamper guards: `no_done_edits`, `no_deleted_tests`, `no_new_skips`,
  `no_disabled_lint`, `no_new_todos`, `no_debug_artifacts` — all diff-based and
  deterministic, with session baselines, rename-aware (a moved test file is
  never "deleted"), and skip/suppression patterns across JS/TS, Python, Go,
  Rust, Java/Kotlin, Ruby, Elixir, C#, PHP, Swift, and Deno
- Stop-hook adapters: Claude Code, Codex CLI, Cursor (`donegate install`),
  with bounce limits, per-session state, and explicit generous hook timeouts
  (agents default to killing hooks at ~60s)
- Windows support (checks run via the platform shell; CI covers Linux, macOS,
  and Windows)
- `donegate run -- <cmd>` — universal wrapper for any other agent or script
- `donegate install ci` — GitHub Actions workflow that gates PRs and posts the
  receipt as a comment
- Receipts: JSON + terminal + markdown renderings, sha-stamped, with baseline
  and diffstat context
- Zero runtime dependencies
