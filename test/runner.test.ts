import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCheck } from '../src/runner.js';
import { cleanup, tmpdir } from './helpers.js';

test('passing check', async () => {
  const root = tmpdir();
  try {
    const result = await runCheck({ name: 'ok', run: 'node -e "console.log(42)"', timeout: 30 }, root);
    assert.equal(result.status, 'pass');
    assert.equal(result.exitCode, 0);
    assert.match(result.outputTail, /42/);
  } finally {
    cleanup(root);
  }
});

test('failing check captures exit code and output', async () => {
  const root = tmpdir();
  try {
    const result = await runCheck(
      { name: 'bad', run: 'node -e "console.error(\'boom\'); process.exit(3)"', timeout: 30 },
      root,
    );
    assert.equal(result.status, 'fail');
    assert.equal(result.exitCode, 3);
    assert.match(result.outputTail, /boom/);
  } finally {
    cleanup(root);
  }
});

test('timeout kills the check', async () => {
  const root = tmpdir();
  try {
    const start = Date.now();
    const result = await runCheck(
      { name: 'slow', run: 'node -e "setTimeout(() => {}, 60000)"', timeout: 1 },
      root,
    );
    assert.equal(result.status, 'timeout');
    assert.ok(Date.now() - start < 10_000, 'should not wait for the full child');
  } finally {
    cleanup(root);
  }
});

test('unrunnable command reports as fail, not crash', async () => {
  const root = tmpdir();
  try {
    const result = await runCheck(
      { name: 'nope', run: 'definitely-not-a-real-binary-xyz', timeout: 30 },
      root,
    );
    assert.notEqual(result.status, 'pass');
  } finally {
    cleanup(root);
  }
});
