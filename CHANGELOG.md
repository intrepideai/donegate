# Changelog

## 0.1.0

Initial release.

- `DONE.md` — a machine-enforceable definition of done that lives in your repo
- `donegate init` — stack autodetection (node/pnpm/yarn/bun, python/uv, go,
  rust, ruby, make) and DONE.md scaffolding
- `donegate check` — runs every check, runs the tamper guards, writes a receipt
  (exit codes: 0 done, 1 checks failed, 2 config error, 3 guards tripped)
- Tamper guards: `no_done_edits`, `no_deleted_tests`, `no_new_skips`,
  `no_disabled_lint`, `no_new_todos`, `no_debug_artifacts` — all diff-based and
  deterministic, with session baselines
- Stop-hook adapters: Claude Code, Codex CLI, Cursor (`donegate install`),
  with bounce limits and per-session state
- `donegate run -- <cmd>` — universal wrapper for any other agent or script
- `donegate install ci` — GitHub Actions workflow that gates PRs and posts the
  receipt as a comment
- Receipts: JSON + terminal + markdown renderings, sha-stamped, with baseline
  and diffstat context
- Zero runtime dependencies
