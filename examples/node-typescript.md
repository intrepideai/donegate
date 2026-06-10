# Definition of Done

> Enforced by [donegate](https://github.com/intrepideai/donegate).

**Done here means:** the types compile, the linter is clean, every test passes
from a real run, and the build succeeds — with no tests skipped or deleted and
no suppressions added to get there.

```yaml
version: 1

checks:
  - name: typecheck
    run: npx tsc --noEmit
  - name: lint
    run: npm run lint
  - name: tests
    run: npm test
    timeout: 900
  - name: build
    run: npm run build
    timeout: 900

guards:
  no_new_todos: true        # stricter than default: TODOs fail the gate

gate:
  max_bounces: 3
```

## For agents

You are not done until `npx donegate check` exits 0. Fix root causes —
`.skip`, `.only`, `@ts-ignore`, and `eslint-disable` are all detected.
