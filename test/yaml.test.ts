import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml, YamlError } from '../src/yaml.js';

test('parses scalars with types', () => {
  const doc = parseYaml(`
version: 1
name: hello
pi: 3.14
on: true
off_: false
nothing: null
tilde: ~
negative: -7
`) as Record<string, unknown>;
  assert.equal(doc.version, 1);
  assert.equal(doc.name, 'hello');
  assert.equal(doc.pi, 3.14);
  assert.equal(doc.on, true);
  assert.equal(doc.off_, false);
  assert.equal(doc.nothing, null);
  assert.equal(doc.tilde, null);
  assert.equal(doc.negative, -7);
});

test('parses nested maps and sequences of maps', () => {
  const doc = parseYaml(`
checks:
  - name: tests
    run: npm test
    timeout: 300
  - name: lint
    run: npm run lint
gate:
  max_bounces: 5
`) as { checks: Array<Record<string, unknown>>; gate: Record<string, unknown> };
  assert.equal(doc.checks.length, 2);
  assert.deepEqual(doc.checks[0], { name: 'tests', run: 'npm test', timeout: 300 });
  assert.deepEqual(doc.checks[1], { name: 'lint', run: 'npm run lint' });
  assert.equal(doc.gate.max_bounces, 5);
});

test('values may contain colons, hashes inside quotes, and quotes', () => {
  const doc = parseYaml(`
a: npm test -- --grep "x: y"
b: echo "#1 result"
c: 'it''s quoted'
d: "tab\\there"
url: https://example.com/path
`) as Record<string, unknown>;
  assert.equal(doc.a, 'npm test -- --grep "x: y"');
  assert.equal(doc.b, 'echo "#1 result"');
  assert.equal(doc.c, "it's quoted");
  assert.equal(doc.d, 'tab\there');
  assert.equal(doc.url, 'https://example.com/path');
});

test('strips comments outside quotes only', () => {
  const doc = parseYaml(`
a: run this # but not this
b: "keep # this"
`) as Record<string, unknown>;
  assert.equal(doc.a, 'run this');
  assert.equal(doc.b, 'keep # this');
});

test('inline sequences', () => {
  const doc = parseYaml(`globs: ["**/*.test.ts", "spec/**", plain]`) as Record<string, unknown>;
  assert.deepEqual(doc.globs, ['**/*.test.ts', 'spec/**', 'plain']);
});

test('sequence items that are bare scalars or URLs', () => {
  const doc = parseYaml(`
items:
  - plain
  - https://example.com
  - 42
`) as { items: unknown[] };
  assert.deepEqual(doc.items, ['plain', 'https://example.com', 42]);
});

test('literal block scalars', () => {
  const doc = parseYaml(`
script: |
  line one
  line two
chomped: |-
  no trailing newline
folded: >
  folds into
  one line
`) as Record<string, string>;
  assert.equal(doc.script, 'line one\nline two\n');
  assert.equal(doc.chomped, 'no trailing newline');
  assert.equal(doc.folded, 'folds into one line');
});

test('rejects tabs in indentation with line number', () => {
  assert.throws(
    () => parseYaml('a:\n\tb: 1'),
    (err: unknown) => err instanceof YamlError && err.line === 2,
  );
});

test('rejects duplicate keys', () => {
  assert.throws(() => parseYaml('a: 1\na: 2'), /duplicate key "a"/);
});

test('rejects flow maps with a helpful message', () => {
  assert.throws(() => parseYaml('a: {x: 1}'), /inline maps are not supported/);
});

test('rejects bad indentation', () => {
  assert.throws(() => parseYaml('a:\n  b: 1\n   c: 2'), YamlError);
});

test('empty document parses to null', () => {
  assert.equal(parseYaml('\n# just a comment\n'), null);
});
