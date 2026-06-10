# Definition of Done

> Enforced by [donegate](https://github.com/intrepideai/donegate).

**Done here means:** the whole workspace is green — not just the package you
touched. Pipelines are cached, so unchanged packages cost ~nothing.

```yaml
version: 1

checks:
  - name: typecheck
    run: pnpm turbo typecheck
    timeout: 1200
  - name: lint
    run: pnpm turbo lint
    timeout: 1200
  - name: tests
    run: pnpm turbo test
    timeout: 1800
  - name: build
    run: pnpm turbo build
    timeout: 1800

guards:
  test_globs: ["**/*.test.*", "**/*.spec.*", "**/__tests__/**", "e2e/**"]

gate:
  max_bounces: 4
```

## For agents

You are not done until `npx donegate check` exits 0 from the workspace root.
A donefile is discovered by walking upward, so the gate works from any package
directory.
