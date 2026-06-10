# Definition of Done

> donegate gates itself with itself. When an agent — or a human — says this
> repo's work is "done", the checks below decide whether that's true.

**Done here means:** types are sound, the full test suite passes from a real
run, and nothing was skipped, deleted, or suppressed to get there.

```yaml
version: 1

checks:
  - name: typecheck
    run: npm run typecheck
  - name: tests
    run: npm test
    timeout: 600

guards:
  # These files legitimately CONTAIN skip/suppression patterns (they're the
  # pattern definitions and their tests), so they're exempt from line scanning.
  exclude:
    - src/guards.ts
    - src/baseline.ts
    - test/guards.test.ts
    - test/receipt.test.ts
    - test/install.test.ts

gate:
  max_bounces: 3
```

## For agents

You are not done until `node dist/cli.js check` (or `npx donegate check`) exits 0.
If the gate bounces you, fix the underlying problem. Skipping tests, deleting
tests, adding `@ts-ignore`, or editing this file are all detected by diff-based
guards and will be reported on the receipt.
