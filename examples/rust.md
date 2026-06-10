# Definition of Done

> Enforced by [donegate](https://github.com/intrepideai/donegate).

```yaml
version: 1

checks:
  - name: fmt
    run: cargo fmt --check
  - name: clippy
    run: cargo clippy --quiet -- -D warnings
    timeout: 900
  - name: tests
    run: cargo test --quiet
    timeout: 1800

gate:
  max_bounces: 3
```

## For agents

You are not done until `npx donegate check` exits 0. Added `#[ignore]` and
`#[allow(...)]` attributes are detected and reported.
