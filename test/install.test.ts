import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureGitignore, installAgent, installCi, uninstallAgent, uninstallCi } from '../src/install.js';
import { cleanup, read, tmpdir, write } from './helpers.js';

test('claude install merges into existing settings without clobbering', () => {
  const root = tmpdir();
  try {
    write(
      root,
      '.claude/settings.json',
      JSON.stringify({
        permissions: { allow: ['Bash(npm test)'] },
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'my-existing-hook.sh' }] }],
        },
      }),
    );
    const result = installAgent('claude', root);
    assert.equal(result.action, 'installed');
    const config = JSON.parse(read(root, '.claude/settings.json'));
    // existing config preserved
    assert.deepEqual(config.permissions, { allow: ['Bash(npm test)'] });
    assert.equal(config.hooks.Stop.length, 2);
    assert.equal(config.hooks.Stop[0].hooks[0].command, 'my-existing-hook.sh');
    assert.match(config.hooks.Stop[1].hooks[0].command, /donegate hook claude/);
    assert.match(config.hooks.SessionStart[0].hooks[0].command, /donegate baseline/);
  } finally {
    cleanup(root);
  }
});

test('install is idempotent', () => {
  const root = tmpdir();
  try {
    assert.equal(installAgent('codex', root).action, 'installed');
    assert.equal(installAgent('codex', root).action, 'already-installed');
    const config = JSON.parse(read(root, '.codex/hooks.json'));
    assert.equal(config.hooks.Stop.length, 1);
  } finally {
    cleanup(root);
  }
});

test('cursor uses flat entries and version field', () => {
  const root = tmpdir();
  try {
    installAgent('cursor', root);
    const config = JSON.parse(read(root, '.cursor/hooks.json'));
    assert.equal(config.version, 1);
    assert.match(config.hooks.stop[0].command, /donegate hook cursor/);
    assert.match(config.hooks.sessionStart[0].command, /donegate baseline/);
  } finally {
    cleanup(root);
  }
});

test('uninstall removes only donegate entries', () => {
  const root = tmpdir();
  try {
    write(
      root,
      '.claude/settings.json',
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'keep-me.sh' }] }] },
      }),
    );
    installAgent('claude', root);
    const result = uninstallAgent('claude', root);
    assert.ok(result);
    const config = JSON.parse(read(root, '.claude/settings.json'));
    assert.equal(config.hooks.Stop.length, 1);
    assert.equal(config.hooks.Stop[0].hooks[0].command, 'keep-me.sh');
    assert.equal(config.hooks.SessionStart, undefined);
  } finally {
    cleanup(root);
  }
});

test('refuses to modify corrupt settings', () => {
  const root = tmpdir();
  try {
    write(root, '.claude/settings.json', '{ not json');
    assert.throws(() => installAgent('claude', root), /refusing to modify/);
  } finally {
    cleanup(root);
  }
});

test('ci workflow install/uninstall respects ownership marker', () => {
  const root = tmpdir();
  try {
    const result = installCi(root);
    assert.equal(result.action, 'installed');
    assert.match(read(root, '.github/workflows/donegate.yml'), /donegate check/);
    assert.equal(installCi(root).action, 'already-installed');
    assert.ok(uninstallCi(root));

    // a user-owned workflow with the same name is never deleted
    write(root, '.github/workflows/donegate.yml', 'name: mine\n');
    assert.equal(uninstallCi(root), null);
  } finally {
    cleanup(root);
  }
});

test('ensureGitignore appends once', () => {
  const root = tmpdir();
  try {
    write(root, '.gitignore', 'node_modules/\n');
    assert.equal(ensureGitignore(root), true);
    assert.equal(ensureGitignore(root), false);
    assert.equal(read(root, '.gitignore'), 'node_modules/\n.donegate/\n');
  } finally {
    cleanup(root);
  }
});
