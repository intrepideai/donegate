import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBaselineHook, runStopHook } from '../src/hooks.js';
import { BASIC_DONEFILE, cleanup, gitCommitAll, gitInit, tmpdir, write } from './helpers.js';

const FAILING_DONEFILE = `# DoD
\`\`\`yaml
checks:
  - name: tests
    run: node -e "console.error('2 tests failed'); process.exit(1)"
gate:
  max_bounces: 2
\`\`\`
`;

function payload(root: string, session = 'sess'): string {
  return JSON.stringify({ session_id: session, cwd: root, hook_event_name: 'Stop' });
}

async function setup(donefile: string): Promise<string> {
  const root = tmpdir();
  gitInit(root);
  write(root, 'DONE.md', donefile);
  gitCommitAll(root);
  return root;
}

test('claude: failing gate blocks with reason, then gives up after max_bounces', async () => {
  const root = await setup(FAILING_DONEFILE);
  try {
    for (const attempt of [1, 2]) {
      const outcome = await runStopHook('claude', payload(root));
      assert.ok(outcome.stdout, 'expected protocol output');
      const response = JSON.parse(outcome.stdout) as { decision: string; reason: string };
      assert.equal(response.decision, 'block');
      assert.match(response.reason, new RegExp(`attempt ${attempt}/2`));
      assert.match(response.reason, /2 tests failed/);
      assert.equal(outcome.exitCode, 0);
    }
    // third attempt: bounces exhausted → allow with warning
    const final = await runStopHook('claude', payload(root));
    assert.equal(final.stdout, null);
    assert.match(final.stderr ?? '', /giving up/);
    assert.equal(final.exitCode, 0);
  } finally {
    cleanup(root);
  }
});

test('claude: passing gate allows stop silently and resets bounce state', async () => {
  const root = await setup(FAILING_DONEFILE);
  try {
    await runStopHook('claude', payload(root)); // bounce once
    write(root, 'DONE.md', BASIC_DONEFILE); // make the gate pass (counts as done-edit? no baseline → modified...)
    gitCommitAll(root); // commit so no_done_edits sees a clean tree
    const outcome = await runStopHook('claude', payload(root));
    assert.equal(outcome.stdout, null);
    assert.match(outcome.stderr ?? '', /DONE/);
    assert.equal(outcome.exitCode, 0);
    // bounce state was reset → next failure starts at attempt 1
    write(root, 'DONE.md', FAILING_DONEFILE);
    gitCommitAll(root);
    const again = await runStopHook('claude', payload(root));
    assert.match(JSON.parse(again.stdout!).reason, /attempt 1\/2/);
  } finally {
    cleanup(root);
  }
});

test('codex shares the claude contract', async () => {
  const root = await setup(FAILING_DONEFILE);
  try {
    const outcome = await runStopHook('codex', payload(root));
    assert.equal(JSON.parse(outcome.stdout!).decision, 'block');
  } finally {
    cleanup(root);
  }
});

test('cursor: failing gate returns followup_message; aborted turns are ignored', async () => {
  const root = await setup(FAILING_DONEFILE);
  try {
    const failing = await runStopHook(
      'cursor',
      JSON.stringify({ conversation_id: 'c', workspace_roots: [root], status: 'completed' }),
    );
    const response = JSON.parse(failing.stdout!) as { followup_message: string };
    assert.match(response.followup_message, /NOT DONE/);

    const aborted = await runStopHook(
      'cursor',
      JSON.stringify({ conversation_id: 'c', workspace_roots: [root], status: 'aborted' }),
    );
    assert.equal(aborted.stdout, null);
  } finally {
    cleanup(root);
  }
});

test('repo without DONE.md is a silent no-op', async () => {
  const root = tmpdir();
  try {
    const outcome = await runStopHook('claude', payload(root));
    assert.equal(outcome.stdout, null);
    assert.equal(outcome.stderr, null);
    assert.equal(outcome.exitCode, 0);
  } finally {
    cleanup(root);
  }
});

test('broken DONE.md warns but never traps the agent', async () => {
  const root = tmpdir();
  try {
    write(root, 'DONE.md', '# no yaml block here\n');
    const outcome = await runStopHook('claude', payload(root));
    assert.equal(outcome.stdout, null);
    assert.match(outcome.stderr ?? '', /allowing stop/);
    assert.equal(outcome.exitCode, 0);
  } finally {
    cleanup(root);
  }
});

test('malformed stdin behaves like a manual gate, not a crash', async () => {
  const root = await setup(FAILING_DONEFILE);
  try {
    // cwd comes from process.cwd() fallback — chdir into the repo for this one.
    const prev = process.cwd();
    process.chdir(root);
    try {
      const outcome = await runStopHook('claude', 'not json at all');
      assert.ok(outcome.stdout);
      assert.equal(JSON.parse(outcome.stdout).decision, 'block');
    } finally {
      process.chdir(prev);
    }
  } finally {
    cleanup(root);
  }
});

test('baseline hook records once with --if-missing', async () => {
  const root = await setup(BASIC_DONEFILE);
  try {
    const first = await runBaselineHook({ ifMissing: true, quiet: false, cwd: root });
    assert.match(first.stderr ?? '', /baseline recorded/);
    const second = await runBaselineHook({ ifMissing: true, quiet: false, cwd: root });
    assert.equal(second.stderr, null);
  } finally {
    cleanup(root);
  }
});
