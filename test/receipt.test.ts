import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verify } from '../src/check.js';
import { loadLatestReceipt, renderMarkdown } from '../src/receipt.js';
import { BASIC_DONEFILE, cleanup, gitCommitAll, gitInit, tmpdir, write } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'dist', 'cli.js');

test('verify writes a receipt with verdict, sha, and baseline info', async () => {
  const root = tmpdir();
  try {
    gitInit(root);
    write(root, 'DONE.md', BASIC_DONEFILE);
    gitCommitAll(root);
    const summary = await verify({ cwd: root });
    assert.equal(summary.exitCode, 0);
    assert.equal(summary.receipt.verdict, 'pass');
    assert.equal(summary.receipt.receipt_sha.length, 64);

    const loaded = loadLatestReceipt(root);
    assert.ok(loaded);
    assert.equal(loaded.receipt_sha, summary.receipt.receipt_sha);
    assert.equal(loaded.repo.git, true);
  } finally {
    cleanup(root);
  }
});

test('exit codes: 1 for failing checks, 3 for guards-only failure', async () => {
  const root = tmpdir();
  try {
    gitInit(root);
    write(
      root,
      'DONE.md',
      '# d\n```yaml\nchecks:\n  - name: bad\n    run: node -e "process.exit(1)"\n```\n',
    );
    gitCommitAll(root);
    const failing = await verify({ cwd: root });
    assert.equal(failing.exitCode, 1);
    assert.equal(failing.receipt.verdict, 'fail');

    // guards-only failure: checks pass but a test was skipped
    write(root, 'DONE.md', BASIC_DONEFILE);
    write(root, 'test/a.test.ts', "test('one', () => {});\ntest('two', () => {});\n");
    gitCommitAll(root);
    const { writeBaseline } = await import('../src/baseline.js');
    const { loadConfig } = await import('../src/donefile.js');
    await writeBaseline(loadConfig(root));
    write(root, 'test/a.test.ts', "test('one', () => {});\ntest.skip('two', () => {});\n");
    const guardsFail = await verify({ cwd: root });
    assert.equal(guardsFail.exitCode, 3);
    assert.equal(guardsFail.checksFailed, 0);
    assert.ok(guardsFail.guardsFailed > 0);
  } finally {
    cleanup(root);
  }
});

test('markdown receipt renders verdict, table, and guard findings', async () => {
  const root = tmpdir();
  try {
    gitInit(root);
    write(root, 'DONE.md', BASIC_DONEFILE);
    write(root, 'test/a.test.ts', "test('one', () => {});\n");
    gitCommitAll(root);
    const { writeBaseline } = await import('../src/baseline.js');
    const { loadConfig } = await import('../src/donefile.js');
    await writeBaseline(loadConfig(root));
    write(root, 'test/a.test.ts', "test.skip('one', () => {});\n");
    const summary = await verify({ cwd: root });
    const md = renderMarkdown(summary.receipt);
    assert.match(md, /### ❌ donegate: NOT DONE/);
    assert.match(md, /\| `ok` \| ✅ pass \|/);
    assert.match(md, /no_new_skips/);
    assert.match(md, /receipt `[0-9a-f]{16}`/);
  } finally {
    cleanup(root);
  }
});

test('e2e: the built CLI runs init → check in a real repo', () => {
  const root = tmpdir();
  try {
    gitInit(root);
    write(root, 'package.json', JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
    gitCommitAll(root);
    const initOut = execFileSync('node', [CLI, 'init'], { cwd: root, encoding: 'utf8' });
    assert.match(initOut, /created DONE\.md/);
    const checkOut = execFileSync('node', [CLI, 'check'], { cwd: root, encoding: 'utf8' });
    assert.match(checkOut, /DONE — 1 checks passed/);
  } finally {
    cleanup(root);
  }
});

test('e2e: hook protocol over real stdin', () => {
  const root = tmpdir();
  try {
    gitInit(root);
    write(
      root,
      'DONE.md',
      '# d\n```yaml\nchecks:\n  - name: bad\n    run: node -e "process.exit(1)"\n```\n',
    );
    gitCommitAll(root);
    const out = execFileSync('node', [CLI, 'hook', 'claude'], {
      cwd: root,
      encoding: 'utf8',
      input: JSON.stringify({ session_id: 'e2e', cwd: root }),
    });
    const response = JSON.parse(out) as { decision: string };
    assert.equal(response.decision, 'block');
  } finally {
    cleanup(root);
  }
});
