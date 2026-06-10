# Agent integrations

`donegate install <target>` wires the gate into an agent's lifecycle. Two hooks
get installed per agent:

- **session start** → `donegate baseline --if-missing --quiet` — snapshots
  test files and DONE.md so the tamper guards have something to diff against.
- **stop** → `donegate hook <agent>` — runs the full gate when the agent tries
  to finish, and blocks the stop (with the failure report) if the verdict is red.

Project-level installs are the default and are **shareable** — commit the config
and every teammate's agent is gated too. Add `--global` to install at the user
level (`~/.claude`, `~/.codex`, `~/.cursor`) instead; global hooks are silent
no-ops in repos without a DONE.md.

Installed hooks carry an explicit `timeout` (stop: **1800s**, baseline:
**120s**). This matters: agents kill hooks after a short default (Claude Code:
60 seconds), which would silently un-gate any repo whose test suite takes
longer than a minute. Per-check `timeout:` values in DONE.md are the real
budget — keep their sum under the stop timeout.

## Claude Code

`donegate install claude` → `.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "npx -y donegate hook claude" }] }
    ],
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "npx -y donegate baseline --if-missing --quiet" }] }
    ]
  }
}
```

On a red verdict the hook prints `{"decision": "block", "reason": "<report>"}`
— Claude Code keeps the session going and feeds the report to the model.

## Codex CLI

`donegate install codex` → `.codex/hooks.json` (same nested shape and the same
`decision`/`block` stop contract as Claude Code).

## Cursor

`donegate install cursor` → `.cursor/hooks.json`:

```json
{
  "version": 1,
  "hooks": {
    "stop": [{ "command": "npx -y donegate hook cursor" }],
    "sessionStart": [{ "command": "npx -y donegate baseline --if-missing --quiet" }]
  }
}
```

On a red verdict the hook prints `{"followup_message": "<report>"}` and the
agent continues. Aborted/errored turns (`status != "completed"`) are never
gated — ctrl-c means ctrl-c.

## Everything else (aider, OpenClaw, custom scripts, humans)

Any agent that can run a command can be gated:

```sh
donegate run -- aider --message "fix the flaky retry logic"
```

`run` records a baseline, runs your command with stdio passed through, then
runs the gate and exits with the gate's code. Or call `donegate check` yourself
whenever you want a verdict — it's the same gate CI runs.

## CI (GitHub Actions)

`donegate install ci` writes `.github/workflows/donegate.yml`: checkout with
full history (so the merge-base baseline works), run `npx donegate check`, and
post the receipt as a PR comment — including guard findings, so "tests pass
because tests were deleted" is visible right in the review.

## Bounce protection

A stop hook that can block forever is a hostage situation, so every block
increments a per-session bounce counter (`.donegate/state.json`, pruned after
24h). After `gate.max_bounces` (default 3) the gate stops blocking and lets the
stop through with a loud warning — but it keeps verifying, so the receipt
always tells the truth. Sessions that recover reset their counter on the first
green run.

## When the gate itself is the target

A stop hook that can be disarmed by deleting its config file isn't much of a
gate, so the donefile gets special handling:

- **Deleted mid-session** — repos without a DONE.md are normally silent
  no-ops, but if `.donegate/baseline.json` records a donefile that has since
  vanished, the stop is bounced with restore instructions instead. Removing
  donegate for real is still easy — delete `.donegate/` too — it's just not
  something an agent can do as a shortcut without it showing.
- **Broken mid-session** — a donefile that no longer parses *and* no longer
  matches the baseline hash bounces the stop, with the parse error in the
  report. One that was already broken when the session started (or has no
  baseline at all) warns and allows, unchanged: a pre-existing config typo
  must never trap an agent that didn't cause it.

Both paths use the default bounce budget (3) — the donefile that would
normally configure `gate.max_bounces` is exactly the thing that's missing or
unreadable — and both keep every no-trap guarantee: bounded bounces, ctrl-c
respected, never-opted-in repos untouched. The wider map of what an agent
could still do, and why CI is the backstop, is in
[threat-model.md](threat-model.md).
