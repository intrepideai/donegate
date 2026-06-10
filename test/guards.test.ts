import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/donefile.js';
import { writeBaseline } from '../src/baseline.js';
import { resolveComparison, runGuards } from '../src/guards.js';
import type { GuardResult } from '../src/types.js';
import { BASIC_DONEFILE, cleanup, gitCommitAll, gitInit, read, rm, tmpdir, write } from './helpers.js';

const TEST_FILE = `import { test } from 'node:test';

test('one', () => {});
test('two', () => {});
`;

function guard(results: GuardResult[], name: string): GuardResult {
  const found = results.find((g) => g.name === name);
  assert.ok(found, `guard ${name} missing`);
  return found;
}

async function setupRepo(): Promise<string> {
  const root = tmpdir();
  gitInit(root);
  write(root, 'DONE.md', BASIC_DONEFILE);
  write(root, 'src/app.ts', 'export const x = 1;\n');
  write(root, 'test/app.test.ts', TEST_FILE);
  gitCommitAll(root, 'base');
  return root;
}

test('clean session: all guards pass', async () => {
  const root = await setupRepo();
  try {
    const config = loadConfig(root);
    await writeBaseline(config);
    write(root, 'src/app.ts', 'export const x = 2;\n');
    const results = await runGuards(config, await resolveComparison(config));
    for (const g of results) {
      assert.notEqual(g.status, 'fail', `${g.name} should not fail: ${JSON.stringify(g.findings)}`);
    }
  } finally {
    cleanup(root);
  }
});

test('no_new_skips: catches .skip added to a test file (line + snippet)', async () => {
  const root = await setupRepo();
  try {
    const config = loadConfig(root);
    await writeBaseline(config);
    write(root, 'test/app.test.ts', TEST_FILE.replace("test('two'", "test.skip('two'"));
    const results = await runGuards(config, await resolveComparison(config));
    const g = guard(results, 'no_new_skips');
    assert.equal(g.status, 'fail');
    assert.ok(g.findings.some((f) => f.file === 'test/app.test.ts' && typeof f.line === 'number'));
  } finally {
    cleanup(root);
  }
});

test('no_new_skips: catches skip-count rise even without a matching diff line', async () => {
  const root = await setupRepo();
  try {
    const config = loadConfig(root);
    await writeBaseline(config);
    // Rewrite the file wholesale (e.g. agent regenerated it) with a sneaky xit.
    write(root, 'test/app.test.ts', "import { test, it } from 'node:test';\nxit('two', () => {});\ntest('one', () => {});\ntest('extra', () => {});\n");
    const results = await runGuards(config, await resolveComparison(config));
    assert.equal(guard(results, 'no_new_skips').status, 'fail');
  } finally {
    cleanup(root);
  }
});

test('no_deleted_tests: catches deleted test file and dropped counts', async () => {
  const root = await setupRepo();
  try {
    const config = loadConfig(root);
    await writeBaseline(config);
    rm(root, 'test/app.test.ts');
    let results = await runGuards(config, await resolveComparison(config));
    assert.equal(guard(results, 'no_deleted_tests').status, 'fail');

    // restore, then drop one test
    write(root, 'test/app.test.ts', "import { test } from 'node:test';\ntest('one', () => {});\n");
    results = await runGuards(config, await resolveComparison(config));
    const g = guard(results, 'no_deleted_tests');
    assert.equal(g.status, 'fail');
    assert.match(g.findings[0]!.detail, /dropped from 2 to 1/);
  } finally {
    cleanup(root);
  }
});

test('no_disabled_lint: catches suppressions in any code file, ignores markdown', async () => {
  const root = await setupRepo();
  try {
    const config = loadConfig(root);
    await writeBaseline(config);
    write(root, 'src/app.ts', '// eslint-disable-next-line no-explicit-any\nexport const x: any = 1;\n');
    write(root, 'docs/notes.md', 'mentioning eslint-disable in prose is fine\n');
    const results = await runGuards(config, await resolveComparison(config));
    const g = guard(results, 'no_disabled_lint');
    assert.equal(g.status, 'fail');
    assert.equal(g.findings.length, 1);
    assert.equal(g.findings[0]!.file, 'src/app.ts');
  } finally {
    cleanup(root);
  }
});

test('no_done_edits: catches DONE.md modified after baseline', async () => {
  const root = await setupRepo();
  try {
    const config = loadConfig(root);
    await writeBaseline(config);
    write(root, 'DONE.md', read(root, 'DONE.md').replace('process.exit(0)', 'process.exit(0) || true'));
    const results = await runGuards(config, await resolveComparison(config));
    assert.equal(guard(results, 'no_done_edits').status, 'fail');
  } finally {
    cleanup(root);
  }
});

test('a brand-new DONE.md without baseline is not tampering', async () => {
  const root = tmpdir();
  try {
    gitInit(root);
    write(root, 'src/app.ts', 'export const x = 1;\n');
    gitCommitAll(root, 'base');
    write(root, 'DONE.md', BASIC_DONEFILE); // untracked, no baseline
    const config = loadConfig(root);
    const results = await runGuards(config, await resolveComparison(config));
    assert.equal(guard(results, 'no_done_edits').status, 'pass');
  } finally {
    cleanup(root);
  }
});

test('warn-level guards report without failing', async () => {
  const root = await setupRepo();
  try {
    const config = loadConfig(root);
    await writeBaseline(config);
    write(root, 'src/app.ts', 'export const x = 1;\nconsole.log("debugging");\n// TODO: clean up\n');
    const results = await runGuards(config, await resolveComparison(config));
    assert.equal(guard(results, 'no_debug_artifacts').status, 'warn');
    assert.equal(guard(results, 'no_new_todos').status, 'warn');
  } finally {
    cleanup(root);
  }
});

test('disabled guards are skipped', async () => {
  const root = await setupRepo();
  try {
    write(
      root,
      'DONE.md',
      BASIC_DONEFILE.replace(
        '```yaml',
        '```yaml',
      ).replace(
        'version: 1',
        'version: 1\nguards:\n  no_new_skips: false',
      ),
    );
    gitCommitAll(root, 'configure');
    const config = loadConfig(root);
    await writeBaseline(config);
    write(root, 'test/app.test.ts', TEST_FILE.replace("test('two'", "test.skip('two'"));
    const results = await runGuards(config, await resolveComparison(config));
    assert.equal(guard(results, 'no_new_skips').status, 'skipped');
  } finally {
    cleanup(root);
  }
});

test('untracked new test file with skips is caught', async () => {
  const root = await setupRepo();
  try {
    const config = loadConfig(root);
    await writeBaseline(config);
    write(root, 'test/new.test.ts', "import { test } from 'node:test';\ntest.skip('lazy', () => {});\n");
    const results = await runGuards(config, await resolveComparison(config));
    assert.equal(guard(results, 'no_new_skips').status, 'fail');
  } finally {
    cleanup(root);
  }
});

test('renaming a test file is not "deleting" it', async () => {
  const root = await setupRepo();
  try {
    const config = loadConfig(root);
    await writeBaseline(config);
    // git mv equivalent: move the file, keep contents identical
    const content = read(root, 'test/app.test.ts');
    rm(root, 'test/app.test.ts');
    write(root, 'test/app.renamed.test.ts', content);
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'pipe' });
    const results = await runGuards(config, await resolveComparison(config));
    assert.equal(
      guard(results, 'no_deleted_tests').status,
      'pass',
      JSON.stringify(guard(results, 'no_deleted_tests').findings),
    );
    assert.equal(guard(results, 'no_new_skips').status, 'pass');
  } finally {
    cleanup(root);
  }
});

test('renamed test file with a dropped test is still caught at its new path', async () => {
  const root = await setupRepo();
  try {
    const config = loadConfig(root);
    await writeBaseline(config);
    const content = read(root, 'test/app.test.ts');
    rm(root, 'test/app.test.ts');
    // moved AND lost a test
    write(root, 'test/app.renamed.test.ts', content.replace("test('two', () => {});\n", ''));
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'pipe' });
    const results = await runGuards(config, await resolveComparison(config));
    const g = guard(results, 'no_deleted_tests');
    assert.equal(g.status, 'fail');
    assert.match(g.findings[0]!.detail, /dropped from 2 to 1/);
  } finally {
    cleanup(root);
  }
});

test('non-ASCII test filenames survive the diff pipeline', async () => {
  const root = await setupRepo();
  try {
    const config = loadConfig(root);
    await writeBaseline(config);
    write(root, 'test/tëst-ünïcode.test.ts', "import { test } from 'node:test';\ntest.skip('lazy', () => {});\n");
    const results = await runGuards(config, await resolveComparison(config));
    const g = guard(results, 'no_new_skips');
    assert.equal(g.status, 'fail');
    assert.ok(g.findings.some((f) => f.file.includes('ünïcode')));
  } finally {
    cleanup(root);
  }
});

test('outside git without baseline: guards skip with a note', async () => {
  const root = tmpdir();
  try {
    write(root, 'DONE.md', BASIC_DONEFILE);
    const config = loadConfig(root);
    const results = await runGuards(config, await resolveComparison(config));
    assert.ok(results.every((g) => g.status === 'skipped'));
  } finally {
    cleanup(root);
  }
});

test('outside git WITH baseline: snapshot comparisons still work', async () => {
  const root = tmpdir();
  try {
    write(root, 'DONE.md', BASIC_DONEFILE);
    write(root, 'test/app.test.ts', TEST_FILE);
    const config = loadConfig(root);
    await writeBaseline(config);
    write(root, 'test/app.test.ts', "import { test } from 'node:test';\ntest('one', () => {});\n");
    const results = await runGuards(config, await resolveComparison(config));
    assert.equal(guard(results, 'no_deleted_tests').status, 'fail');
  } finally {
    cleanup(root);
  }
});
