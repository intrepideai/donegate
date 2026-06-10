# Definition of Done

> Enforced by [donegate](https://github.com/intrepideai/donegate).

```yaml
version: 1

checks:
  - name: vet
    run: go vet ./...
  - name: tests
    run: go test ./...
    timeout: 900
  - name: race
    run: go test -race ./...
    timeout: 1800

gate:
  max_bounces: 3
```

## For agents

You are not done until `npx donegate check` exits 0. Added `t.Skip()` calls and
`//nolint` directives are detected and reported with file:line evidence.
