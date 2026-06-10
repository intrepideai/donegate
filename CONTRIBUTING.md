# Contributing to donegate

Thanks for helping make "done" mean something.

## Setup

```sh
git clone https://github.com/intrepideai/donegate
cd donegate
npm install
npm test
```

Node >= 20. No other tooling required.

## The rules of the repo

1. **Zero runtime dependencies.** donegate gets installed into people's repos
   and wired into their agents' stop hooks. The entire supply chain must stay
   readable in one sitting. PRs that add a runtime dependency will be asked to
   inline the 30 lines they actually needed.
2. **The gate gates this repo.** `node dist/cli.js check` must exit 0 — CI runs
   it, and so should you. (`donegate install claude` works here too. Dogfood.)
3. **Guards need both tests.** A new tamper pattern needs a test showing it
   catches the cheat *and* a test showing it doesn't fire on legitimate code.
   False positives erode trust faster than misses.
4. **Deterministic only.** Checks and guards must not call LLMs, networks, or
   anything non-reproducible. A receipt should mean the same thing on any
   machine.

## Good first contributions

- Skip/suppression patterns for languages we cover thinly (PHP, C#, Swift,
  Elixir, Scala…) — see `SKIP_PATTERNS` and `LINT_DISABLE_PATTERNS` in
  [src/guards.ts](src/guards.ts), and `COUNTERS` in [src/baseline.ts](src/baseline.ts).
- Stack detection for `donegate init` — see [src/init.ts](src/init.ts).
- Adapters for more agents (the protocol surface is small — see
  [src/hooks.ts](src/hooks.ts) and [docs/hooks.md](docs/hooks.md)).

## Releases

Maintainers cut releases by tagging `vX.Y.Z`; CI publishes to npm with
provenance.
