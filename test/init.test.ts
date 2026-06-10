import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectStack, renderDonefile } from '../src/init.js';
import { parseDonefileSource } from '../src/donefile.js';
import { cleanup, tmpdir, write } from './helpers.js';

function names(root: string): string[] {
  return detectStack(root).checks.map((c) => c.name);
}

test('node repo with scripts and tsconfig', () => {
  const root = tmpdir();
  try {
    write(
      root,
      'package.json',
      JSON.stringify({ scripts: { test: 'vitest run', lint: 'eslint .', build: 'tsc -b' } }),
    );
    write(root, 'tsconfig.json', '{}');
    const detection = detectStack(root);
    assert.deepEqual(
      detection.checks.map((c) => [c.name, c.run]),
      [
        ['typecheck', 'npx tsc --noEmit'],
        ['lint', 'npm run lint'],
        ['tests', 'npm test'],
        ['build', 'npm run build'],
      ],
    );
  } finally {
    cleanup(root);
  }
});

test('pnpm is detected via lockfile', () => {
  const root = tmpdir();
  try {
    write(root, 'package.json', JSON.stringify({ scripts: { test: 'vitest run' } }));
    write(root, 'pnpm-lock.yaml', '');
    const detection = detectStack(root);
    assert.deepEqual(detection.checks[0], { name: 'tests', run: 'pnpm test' });
  } finally {
    cleanup(root);
  }
});

test('npm placeholder test script is ignored', () => {
  const root = tmpdir();
  try {
    write(
      root,
      'package.json',
      JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
    );
    assert.deepEqual(names(root), []);
  } finally {
    cleanup(root);
  }
});

test('python repo with pytest, ruff, uv', () => {
  const root = tmpdir();
  try {
    write(root, 'pyproject.toml', '[tool.ruff]\nline-length = 100\n[tool.pytest.ini_options]\n');
    write(root, 'uv.lock', '');
    const detection = detectStack(root);
    assert.deepEqual(
      detection.checks.map((c) => [c.name, c.run]),
      [
        ['lint', 'uv run ruff check .'],
        ['tests', 'uv run pytest -q'],
      ],
    );
  } finally {
    cleanup(root);
  }
});

test('go and rust repos', () => {
  const root = tmpdir();
  try {
    write(root, 'go.mod', 'module example.com/x\n');
    assert.deepEqual(names(root), ['vet', 'tests']);
  } finally {
    cleanup(root);
  }
  const root2 = tmpdir();
  try {
    write(root2, 'Cargo.toml', '[package]\nname = "x"\n');
    assert.deepEqual(names(root2), ['fmt', 'clippy', 'tests']);
  } finally {
    cleanup(root2);
  }
});

test('makefile fallback', () => {
  const root = tmpdir();
  try {
    write(root, 'Makefile', 'test:\n\tgo test ./...\nlint:\n\tgolangci-lint run\n');
    assert.deepEqual(names(root), ['tests', 'lint']);
  } finally {
    cleanup(root);
  }
});

test('rendered DONE.md is parseable by donegate itself', () => {
  const root = tmpdir();
  try {
    write(root, 'package.json', JSON.stringify({ scripts: { test: 'node --test' } }));
    const rendered = renderDonefile(detectStack(root));
    const config = parseDonefileSource(rendered, '/r/DONE.md', '/r');
    assert.equal(config.checks[0]!.name, 'tests');
    assert.equal(config.gate.max_bounces, 3);
  } finally {
    cleanup(root);
  }
});

test('empty repo renders a failing placeholder that is still parseable', () => {
  const root = tmpdir();
  try {
    const rendered = renderDonefile(detectStack(root));
    const config = parseDonefileSource(rendered, '/r/DONE.md', '/r');
    assert.equal(config.checks.length, 1);
    assert.match(config.checks[0]!.run, /exit 1/);
  } finally {
    cleanup(root);
  }
});
