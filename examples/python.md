# Definition of Done

> Enforced by [donegate](https://github.com/intrepideai/donegate).

**Done here means:** ruff is clean, the types check, and the whole pytest suite
passes — no `xfail`, no `skipif` smuggled in, no `# noqa` confetti.

```yaml
version: 1

checks:
  - name: lint
    run: uv run ruff check .
  - name: typecheck
    run: uv run mypy .
  - name: tests
    run: uv run pytest -q
    timeout: 900

guards:
  test_globs: ["**/test_*.py", "**/*_test.py", "tests/**", "**/conftest.py"]

gate:
  max_bounces: 3
```

## For agents

You are not done until `npx donegate check` exits 0 (or `uvx --from donegate…`
if you must — it's a node CLI, `npx` is fine on any repo). Fix root causes:
`@pytest.mark.skip`, `xfail`, and `# noqa` additions are detected and reported.
