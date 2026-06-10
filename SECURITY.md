# Security Policy

donegate runs inside developer machines and CI, wired into agent stop hooks —
we take that position seriously. That's also why it has **zero runtime
dependencies** and a codebase you can audit in one sitting.

## Reporting a vulnerability

Email **security@intrepide.ai** with details and a proof of concept if you have
one. We'll acknowledge within 48 hours. Please don't open public issues for
security reports.

## Scope notes

- donegate executes the commands **you** declare in DONE.md, in your shell, in
  your repo. It never executes anything it discovers on its own.
- donegate makes **no network calls**. If you ever observe one, that is a
  vulnerability — report it.
- Guards are heuristics for catching agents gaming a gate; they are not a
  sandbox and not a substitute for reviewing what an agent did.
