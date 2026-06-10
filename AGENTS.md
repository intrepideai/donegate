# AGENTS.md

Instructions for coding agents working in this repo.

## Project

donegate is a zero-dependency TypeScript CLI that enforces a repo's definition
of done (`DONE.md`) on coding agents via stop hooks, with diff-based tamper
guards and receipts. Node >= 20, ESM, strict TypeScript.

## Commands

- Build: `npm run build`
- Typecheck: `npm run typecheck`
- Test: `npm test` (builds first, then runs `node --test` via tsx)
- Full gate: `node dist/cli.js check`

## Definition of done

This repo is gated by its own [DONE.md](DONE.md). You are not done until
`node dist/cli.js check` exits 0. Do not skip tests, delete tests, or add
suppressions to satisfy the gate — the guards detect that.

## Conventions

- **Zero runtime dependencies.** Do not add packages to `dependencies`. This is
  a security and auditability promise, not a preference. devDependencies stay
  minimal (typescript, tsx, @types/node).
- ESM with `.js` extensions on relative imports (`./foo.js`).
- Errors users can act on: include the file, the value, and what to do instead.
- New guard patterns need a test in `test/guards.test.ts` proving both the
  catch and the non-false-positive case.
- Public behavior (CLI flags, DONE.md schema, hook protocol, receipt schema) is
  documented in `docs/spec.md` — update it in the same change.
