# FAQ

### Won't the agent just edit DONE.md to make the gate easier?

That's the first thing we built a guard for. The session baseline records the
DONE.md hash; if it changes before the gate passes, `no_done_edits` trips and
the verdict is red with the receipt saying exactly that. Same for deleting the
file.

### Won't it just skip or delete the failing tests?

`no_new_skips` catches added `.skip`/`.only`/`xfail`/`t.Skip()`/`#[ignore]`
(and skip-count rises even in wholesale rewrites); `no_deleted_tests` catches
removed files *and* dropped test counts per file. The receipt shows `file:line`
and the offending snippet.

### What if the agent writes new tests that assert the broken behavior?

Then you've hit the limit of what determinism can check — no tool can know your
*intent*. donegate's job is to make cheating **visible and loud** instead of
silent: the receipt shows the diffstat, every check that ran, and every
suspicious move. Review the diff like you would a human's; donegate guarantees
you're reviewing what actually ran, not what the agent claims ran.

### Does donegate call an LLM to judge the work?

No. Never. Checks are your own shell commands; guards are diffs and regexes.
Same tree → same verdict, on any machine, with zero API keys and zero network
calls. (An *optional* LLM judge check type has been considered and rejected for
core — if you want one, add it as a `run:` command that calls your own tooling
and exits non-zero.)

### Why not just rely on CI?

CI is the backstop, not the loop. The stop hook fires *while the agent still
has context* — it gets the failure report and fixes the problem in the same
session, instead of you discovering it 10 minutes later in a PR. Use both:
`donegate install claude` for the loop, `donegate install ci` for the backstop.

### Isn't this what Claude Code hooks / Codex hooks already do?

Hooks are the *mechanism* — donegate is the *contract*. People hand-roll stop
hooks per agent, per repo, with no tamper detection and no artifact. DONE.md is
one file that travels with the repo and gates every agent the same way, with
receipts you can post on a PR.

### My agent got stuck in a bounce loop on a flaky test. Help?

The gate gives up blocking after `gate.max_bounces` (default 3) per session and
lets the stop through with a warning — by design it cannot trap an agent
forever. Also: a test flaky enough to bounce your agent is flaky enough to
bounce a teammate; DONE.md just made it visible.

### Does it work on Windows?

Checks run via `cmd.exe /c` on Windows and the rest is pathname-safe in theory
— but CI currently covers Linux and macOS only. Windows reports welcome.

### Why YAML inside markdown instead of a plain config file?

Because the definition of done deserves prose: *why* these checks, what "done"
means in this team, notes for agents. `DONE.md` sits next to `README.md` and
`AGENTS.md` where both humans and agents already look. (Plain `done.yml` works
too if you prefer.)
