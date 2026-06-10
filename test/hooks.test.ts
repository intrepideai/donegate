import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBaselineHook, runStopHook } from '../src/hooks.js';
import { BASIC_DONEFILE, cleanup, gitCommitAll, gitInit, rm, tmpdir, write } from './helpers.js';

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

test('deleting the donefile mid-session bounces instead of bypassing the gate', async () => {
  const root = await setup(BASIC_DONEFILE);
  try {
    await runBaselineHook({ ifMissing: false, quiet: true, cwd: root });
    rm(root, 'DONE.md');

    for (const attempt of [1, 2, 3]) {
      const outcome = await runStopHook('claude', payload(root));
      assert.ok(outcome.stdout, 'expected a block');
      const response = JSON.parse(outcome.stdout) as { decision: string; reason: string };
      assert.equal(response.decision, 'block');
      assert.match(response.reason, /DONE\.md was deleted mid-session/);
      assert.match(response.reason, new RegExp(`attempt ${attempt}/3`));
    }

    // bounce budget spent → allow, loudly, with the way out spelled out
    const final = await runStopHook('claude', payload(root));
    assert.equal(final.stdout, null);
    assert.match(final.stderr ?? '', /giving up/);
    assert.equal(final.exitCode, 0);

    // restoring the donefile brings the gate back to green and resets the session
    write(root, 'DONE.md', BASIC_DONEFILE);
    const restored = await runStopHook('claude', payload(root));
    assert.equal(restored.stdout, null);
    assert.match(restored.stderr ?? '', /✓ DONE/);
  } finally {
    cleanup(root);
  }
});

test('breaking the donefile mid-session bounces instead of failing open', async () => {
  const root = await setup(BASIC_DONEFILE);
  try {
    await runBaselineHook({ ifMissing: false, quiet: true, cwd: root });
    write(root, 'DONE.md', '# the yaml block went missing\n');

    const outcome = await runStopHook('claude', payload(root));
    assert.ok(outcome.stdout, 'expected a block');
    const response = JSON.parse(outcome.stdout) as { decision: string; reason: string };
    assert.equal(response.decision, 'block');
    assert.match(response.reason, /modified mid-session and no longer parses/);

    // repairing the donefile brings the gate back to green
    write(root, 'DONE.md', BASIC_DONEFILE);
    const repaired = await runStopHook('claude', payload(root));
    assert.equal(repaired.stdout, null);
    assert.match(repaired.stderr ?? '', /✓ DONE/);
  } finally {
    cleanup(root);
  }
});

test('cursor: aborted turns are not gated even when the donefile is gone', async () => {
  const root = await setup(BASIC_DONEFILE);
  try {
    await runBaselineHook({ ifMissing: false, quiet: true, cwd: root });
    rm(root, 'DONE.md');

    const aborted = await runStopHook(
      'cursor',
      JSON.stringify({ conversation_id: 'c', workspace_roots: [root], status: 'aborted' }),
    );
    assert.equal(aborted.stdout, null);

    const completed = await runStopHook(
      'cursor',
      JSON.stringify({ conversation_id: 'c', workspace_roots: [root], status: 'completed' }),
    );
    const response = JSON.parse(completed.stdout!) as { followup_message: string };
    assert.match(response.followup_message, /deleted mid-session/);
  } finally {
    cleanup(root);
  }
});

// Assembled at runtime so the repo's own no_new_skips guard never sees the
// literal marker in this (non-excluded) test file.
const SKIP_CALL = ['test', 'skip'].join('.');

test('subagent boundary: guards-only — failing checks do not block, tampering does', async () => {
  const root = await setup(FAILING_DONEFILE);
  try {
    write(root, 'test/app.test.ts', "import { test } from 'node:test';\ntest('one', () => {});\ntest('two', () => {});\n");
    gitCommitAll(root);
    await runBaselineHook({ ifMissing: false, quiet: true, cwd: root });

    // the donefile's check always fails, but the boundary doesn't run checks
    const clean = await runStopHook('claude', payload(root), { subagent: true });
    assert.equal(clean.stdout, null);
    assert.match(clean.stderr ?? '', /subagent boundary clean/);

    // tamper at the boundary → blocked with the guard finding
    write(root, 'test/app.test.ts', `import { test } from 'node:test';\ntest('one', () => {});\n${SKIP_CALL}('two', () => {});\n`);
    const tampered = await runStopHook('claude', payload(root), { subagent: true });
    assert.ok(tampered.stdout, 'expected a block');
    const response = JSON.parse(tampered.stdout) as { decision: string; reason: string };
    assert.equal(response.decision, 'block');
    assert.match(response.reason, /no_new_skips/);

    // subagent bounces live in their own ledger — the terminal gate still starts fresh
    const main = await runStopHook('claude', payload(root));
    assert.match(JSON.parse(main.stdout!).reason as string, /attempt 1\/2/);
  } finally {
    cleanup(root);
  }
});

const PROGRESS_DONEFILE = `# DoD
\`\`\`yaml
checks:
  - name: c1
    run: node -e "process.exit(require('fs').existsSync('fix1.txt') ? 0 : 1)"
  - name: c2
    run: node -e "process.exit(require('fs').existsSync('fix2.txt') ? 0 : 1)"
gate:
  max_bounces: 2
\`\`\`
`;

test('progress refreshes the bounce budget; stalling exhausts it', async () => {
  const root = await setup(PROGRESS_DONEFILE);
  try {
    const block = async () => {
      const outcome = await runStopHook('claude', payload(root));
      assert.ok(outcome.stdout, 'expected a block');
      return JSON.parse(outcome.stdout) as { decision: string; reason: string };
    };

    // two failing checks, no movement: the budget counts down
    assert.match((await block()).reason, /attempt 1\/2/);
    assert.match((await block()).reason, /attempt 2\/2/);

    // fixing one check is progress → budget refreshed, loudly
    write(root, 'fix1.txt', 'fixed\n');
    const refreshed = await block();
    assert.match(refreshed.reason, /attempt 1\/2/);
    assert.match(refreshed.reason, /bounce budget was refreshed/);

    // stalling at the new best exhausts the refreshed budget
    assert.match((await block()).reason, /attempt 2\/2/);
    const spent = await runStopHook('claude', payload(root));
    assert.equal(spent.stdout, null);
    assert.match(spent.stderr ?? '', /giving up/);

    // finishing the job still works and clears the session
    write(root, 'fix2.txt', 'fixed\n');
    const done = await runStopHook('claude', payload(root));
    assert.equal(done.stdout, null);
    assert.match(done.stderr ?? '', /✓ DONE/);
  } finally {
    cleanup(root);
  }
});
