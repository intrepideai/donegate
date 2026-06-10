import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DonefileError, extractYamlBlock, findDonefile, parseDonefileSource } from '../src/donefile.js';
import { cleanup, tmpdir, write } from './helpers.js';

const MD = `# Definition of Done

Some prose for humans.

\`\`\`yaml
version: 1
checks:
  - name: tests
    run: npm test
guards:
  no_new_todos: true
  no_debug_artifacts: off
gate:
  max_bounces: 5
\`\`\`

More prose.
`;

test('extracts the first yaml block from markdown', () => {
  const block = extractYamlBlock(MD);
  assert.ok(block);
  assert.match(block.yaml, /name: tests/);
});

test('parses DONE.md with defaults and overrides', () => {
  const config = parseDonefileSource(MD, '/repo/DONE.md', '/repo');
  assert.equal(config.checks.length, 1);
  assert.deepEqual(config.checks[0], { name: 'tests', run: 'npm test', timeout: 600 });
  // overridden
  assert.equal(config.guards.no_new_todos, true);
  assert.equal(config.guards.no_debug_artifacts, false);
  assert.equal(config.gate.max_bounces, 5);
  // defaults intact
  assert.equal(config.guards.no_new_skips, true);
  assert.equal(config.guards.no_done_edits, true);
});

test('parses plain done.yml without markdown fence', () => {
  const config = parseDonefileSource(
    'checks:\n  - name: a\n    run: make test\n',
    '/repo/done.yml',
    '/repo',
  );
  assert.equal(config.checks[0]!.name, 'a');
});

test('a bare-boolean run gets a helpful error', () => {
  assert.throws(
    () => parseDonefileSource('checks:\n  - name: a\n    run: true\n', '/repo/done.yml', '/repo'),
    /run must be a string command.*quote it/,
  );
});

test('rejects DONE.md without a yaml block', () => {
  assert.throws(() => parseDonefileSource('# nope\n', '/repo/DONE.md', '/repo'), /no ```yaml block/);
});

test('rejects empty checks', () => {
  assert.throws(
    () => parseDonefileSource('checks: []\n', '/repo/done.yml', '/repo'),
    /declares no checks/,
  );
});

test('rejects duplicate check names and missing fields', () => {
  assert.throws(
    () =>
      parseDonefileSource(
        'checks:\n  - name: a\n    run: x\n  - name: a\n    run: y\n',
        '/repo/done.yml',
        '/repo',
      ),
    /duplicate check name/,
  );
  assert.throws(
    () => parseDonefileSource('checks:\n  - run: x\n', '/repo/done.yml', '/repo'),
    /missing a "name"/,
  );
  assert.throws(
    () => parseDonefileSource('checks:\n  - name: a\n', '/repo/done.yml', '/repo'),
    /missing a "run"/,
  );
});

test('rejects unknown guards and bad guard values', () => {
  assert.throws(
    () =>
      parseDonefileSource(
        'checks:\n  - name: a\n    run: x\nguards:\n  not_a_guard: true\n',
        '/repo/done.yml',
        '/repo',
      ),
    /unknown guard/,
  );
  assert.throws(
    () =>
      parseDonefileSource(
        'checks:\n  - name: a\n    run: x\nguards:\n  no_new_skips: sometimes\n',
        '/repo/done.yml',
        '/repo',
      ),
    DonefileError,
  );
});

test('rejects out-of-range max_bounces', () => {
  assert.throws(
    () =>
      parseDonefileSource(
        'checks:\n  - name: a\n    run: x\ngate:\n  max_bounces: 0\n',
        '/repo/done.yml',
        '/repo',
      ),
    /max_bounces/,
  );
});

test('findDonefile walks upward and prefers DONE.md', () => {
  const root = tmpdir();
  try {
    write(root, 'DONE.md', MD);
    write(root, 'packages/app/src/index.ts', '');
    const found = findDonefile(path.join(root, 'packages', 'app', 'src'));
    assert.ok(found);
    assert.equal(found.root, root);
    assert.equal(path.basename(found.sourcePath), 'DONE.md');
  } finally {
    cleanup(root);
  }
});

test('parses guards.protect and no_protected_edits', () => {
  const config = parseDonefileSource(
    'checks:\n  - name: a\n    run: x\nguards:\n  no_protected_edits: warn\n  protect:\n    - package.json\n    - "*.config.js"\n',
    '/repo/done.yml',
    '/repo',
  );
  assert.deepEqual(config.guards.protect, ['package.json', '*.config.js']);
  assert.equal(config.guards.no_protected_edits, 'warn');
});
