import fs from 'node:fs';
import path from 'node:path';
import type { Baseline, CheckRunSummary, DoneConfig, GuardFinding, Receipt } from './types.js';
import { DEFAULT_MAX_BOUNCES, findDonefile, loadConfig } from './donefile.js';
import { verify } from './check.js';
import { DONEGATE_DIR, baselinePath, loadBaseline, sha256, writeBaseline } from './baseline.js';
import { ms } from './ui.js';

export type HookAgent = 'claude' | 'codex' | 'cursor';

interface HookPayload {
  session_id?: string;
  conversation_id?: string;
  cwd?: string;
  workspace_roots?: string[];
  hook_event_name?: string;
  stop_hook_active?: boolean;
  status?: string;
  loop_count?: number;
}

interface BounceState {
  sessions: Record<string, { bounces: number; updated_at: string; best?: number }>;
}

function statePath(root: string): string {
  return path.join(root, DONEGATE_DIR, 'state.json');
}

function loadState(root: string): BounceState {
  try {
    const data = JSON.parse(fs.readFileSync(statePath(root), 'utf8')) as BounceState;
    if (typeof data.sessions === 'object' && data.sessions !== null) return data;
  } catch {
    // fresh state
  }
  return { sessions: {} };
}

function saveState(root: string, state: BounceState): void {
  // Prune sessions older than 24h (or with unparseable timestamps) so the
  // file can't grow without bound.
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [id, entry] of Object.entries(state.sessions)) {
    const t = new Date(entry?.updated_at ?? '').getTime();
    if (Number.isNaN(t) || t < cutoff) delete state.sessions[id];
  }
  fs.mkdirSync(path.join(root, DONEGATE_DIR), { recursive: true });
  fs.writeFileSync(statePath(root), JSON.stringify(state, null, 2) + '\n');
}

export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parsePayload(raw: string): HookPayload {
  if (raw.trim() === '') return {};
  try {
    const data = JSON.parse(raw) as unknown;
    return typeof data === 'object' && data !== null ? (data as HookPayload) : {};
  } catch {
    return {};
  }
}

function resolveCwd(payload: HookPayload): string {
  if (payload.cwd && fs.existsSync(payload.cwd)) return payload.cwd;
  const ws = payload.workspace_roots?.[0];
  if (ws && fs.existsSync(ws)) return ws;
  return process.cwd();
}

const MAX_REASON_CHARS = 3500;

function guardLine(f: GuardFinding): string {
  const loc = f.line ? `${f.file}:${f.line}` : f.file;
  return f.snippet ? `${loc} — ${f.detail}: \`${f.snippet}\`` : `${loc} — ${f.detail}`;
}

/** The message fed back to the agent when the gate bounces it. */
export function buildReason(summary: CheckRunSummary, bounce: number, maxBounces: number): string {
  const { receipt } = summary;
  const lines: string[] = [];
  const failing = receipt.checks.filter((c) => c.status !== 'pass');
  const tripped = receipt.guards.filter((g) => g.status === 'fail');
  const warned = receipt.guards.filter((g) => g.status === 'warn');

  lines.push(
    `donegate: NOT DONE — the definition of done in ${receipt.donefile} is not satisfied yet (attempt ${bounce}/${maxBounces}).`,
  );
  lines.push('');

  for (const check of failing) {
    const why =
      check.status === 'timeout'
        ? `timed out after ${ms(check.durationMs)}`
        : check.status === 'error'
          ? 'could not run'
          : `exit ${check.exitCode}`;
    lines.push(`✗ check "${check.name}" failed (${why}): \`${check.run}\``);
    const tail = check.outputTail.replace(/\s+$/, '').split('\n').slice(-15).join('\n').trim();
    if (tail !== '') {
      lines.push('```');
      lines.push(tail);
      lines.push('```');
    }
  }

  for (const guard of tripped) {
    lines.push(`🛑 guard "${guard.name}" tripped:`);
    for (const f of guard.findings.slice(0, 6)) lines.push(`  - ${guardLine(f)}`);
    if (guard.findings.length > 6) lines.push(`  - … and ${guard.findings.length - 6} more`);
  }
  if (warned.length > 0) {
    lines.push(`⚠ warnings (not blocking): ${warned.map((g) => g.name).join(', ')}`);
  }

  lines.push('');
  lines.push(
    'Fix the underlying problems, then finish again. Do NOT skip/delete tests, silence the linter, or edit the donefile to get past this gate — the guards diff the repo and will flag it. Run `npx donegate check` to re-run the gate yourself.',
  );

  let reason = lines.join('\n');
  if (reason.length > MAX_REASON_CHARS) {
    reason = reason.slice(0, MAX_REASON_CHARS - 60) + '\n… (truncated — run `npx donegate check` for the full report)';
  }
  return reason;
}

export interface HookOutcome {
  /** What to print to stdout (protocol JSON), if anything. */
  stdout: string | null;
  /** Human-facing note for stderr. */
  stderr: string | null;
  exitCode: number;
}

/**
 * Walk upward looking for a `.donegate/baseline.json` whose recorded donefile
 * no longer exists. findDonefile() already searched these directories and came
 * up empty, so a hit means the donefile was deleted (or renamed away) after
 * the baseline was taken — mid-session, by definition.
 */
function findOrphanedBaseline(cwd: string): { root: string; baseline: Baseline } | null {
  let dir = path.resolve(cwd);
  while (true) {
    const baseline = loadBaseline(dir);
    if (baseline) {
      if (
        typeof baseline.donefile_path === 'string' &&
        baseline.donefile_path !== '' &&
        !fs.existsSync(path.join(dir, baseline.donefile_path))
      ) {
        return { root: dir, baseline };
      }
      // The nearest baseline governs; if its donefile is accounted for (or it
      // doesn't record one), there is nothing orphaned here.
      return null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Block the stop (incrementing the session's bounce count), or give up loudly
 * once the budget is spent.
 *
 * The budget counts *consecutive bounces without new progress*. When `score`
 * is provided (failing checks + tripped guards), a score strictly below the
 * session's best refreshes the budget: an agent steadily fixing a long list
 * shouldn't be cut off mid-fix. Best-ever (not last-attempt) is the bar, so
 * oscillating between two failure sets can't farm refreshes — total bounces
 * stay bounded by max_bounces × (initial score + 1).
 */
function bounceOrGiveUp(options: {
  agent: HookAgent;
  root: string;
  sessionId: string;
  maxBounces: number;
  score?: number;
  reason: (attempt: number) => string;
  giveUp: (bounces: number) => string;
}): HookOutcome {
  const state = loadState(options.root);
  const entry = state.sessions[options.sessionId];
  let bounces = entry?.bounces ?? 0;
  let best = entry?.best;
  let refreshed = false;

  if (typeof options.score === 'number') {
    if (typeof best !== 'number') {
      best = options.score; // first scored attempt sets the bar
    } else if (options.score < best) {
      best = options.score;
      refreshed = true;
      bounces = 0;
    }
  }

  if (bounces >= options.maxBounces) {
    return { stdout: null, stderr: options.giveUp(bounces), exitCode: 0 };
  }

  const attempt = bounces + 1;
  state.sessions[options.sessionId] = {
    bounces: attempt,
    updated_at: new Date().toISOString(),
    ...(typeof best === 'number' ? { best } : {}),
  };
  saveState(options.root, state);

  let reason = options.reason(attempt);
  if (refreshed) {
    reason += '\n\n(donegate noticed progress since the last attempt — the bounce budget was refreshed.)';
  }

  if (options.agent === 'cursor') {
    return { stdout: JSON.stringify({ followup_message: reason }), stderr: null, exitCode: 0 };
  }
  // claude + codex share the decision/block contract.
  return { stdout: JSON.stringify({ decision: 'block', reason }), stderr: null, exitCode: 0 };
}

export async function runStopHook(
  agent: HookAgent,
  rawStdin: string,
  mode: { subagent?: boolean } = {},
): Promise<HookOutcome> {
  const payload = parsePayload(rawStdin);
  const cwd = resolveCwd(payload);

  // Cursor tells us how the turn ended; don't harass a user who hit ctrl-c.
  if (agent === 'cursor' && payload.status && payload.status !== 'completed') {
    return { stdout: null, stderr: null, exitCode: 0 };
  }

  const sessionId = payload.session_id ?? payload.conversation_id ?? 'default';
  // Subagent boundaries get their own bounce ledger — a noisy fan-out must
  // not burn the budget the terminal stop gate relies on.
  const stateKey = mode.subagent ? `${sessionId}:subagent` : sessionId;

  // No DONE.md → never interfere. A globally-installed hook must be a no-op in
  // repos that haven't opted in. The exception is a session baseline whose
  // donefile has vanished: deleting DONE.md mid-session is not an off switch.
  const found = findDonefile(cwd);
  if (!found) {
    const orphan = findOrphanedBaseline(cwd);
    if (!orphan) return { stdout: null, stderr: null, exitCode: 0 };
    const name = orphan.baseline.donefile_path;
    return bounceOrGiveUp({
      agent,
      root: orphan.root,
      sessionId: stateKey,
      // The donefile (and its gate.max_bounces with it) is gone — use the default.
      maxBounces: DEFAULT_MAX_BOUNCES,
      reason: (attempt) =>
        [
          `donegate: NOT DONE — ${name} was deleted mid-session (attempt ${attempt}/${DEFAULT_MAX_BOUNCES}).`,
          '',
          `The session baseline (${path.join(DONEGATE_DIR, 'baseline.json')}) records that ${name} existed when this session started, and deleting the donefile does not turn the gate off. Restore it (e.g. \`git checkout -- ${name}\`), fix what is actually failing, then finish again. If a human is deliberately removing donegate from this repo, they should delete the ${DONEGATE_DIR}/ directory as well — that switch is not the agent's to flip.`,
        ].join('\n'),
      giveUp: (bounces) =>
        `donegate: ✗ ${name} is still missing after ${bounces} bounce${bounces > 1 ? 's' : ''} — giving up and allowing the stop. Restore ${name}, or delete ${DONEGATE_DIR}/ to remove the gate for real.`,
    });
  }

  let config: DoneConfig;
  try {
    config = loadConfig(cwd);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // If the donefile stopped parsing *and* stopped matching the session
    // baseline, the breakage happened mid-session — treat it like the
    // tampering it almost certainly is, not like a config typo to fail open on.
    const baseline = loadBaseline(found.root);
    if (baseline && typeof baseline.donefile_sha === 'string') {
      let changed: boolean;
      try {
        changed = sha256(fs.readFileSync(found.sourcePath)) !== baseline.donefile_sha;
      } catch {
        changed = true; // readable when the baseline was taken, unreadable now
      }
      if (changed) {
        const name = path.relative(found.root, found.sourcePath).split(path.sep).join('/') || 'DONE.md';
        return bounceOrGiveUp({
          agent,
          root: found.root,
          sessionId: stateKey,
          // The config is unreadable, so its gate.max_bounces is too — use the default.
          maxBounces: DEFAULT_MAX_BOUNCES,
          reason: (attempt) =>
            [
              `donegate: NOT DONE — ${name} was modified mid-session and no longer parses (attempt ${attempt}/${DEFAULT_MAX_BOUNCES}): ${msg}`,
              '',
              `The definition of done is not the agent's to edit. Restore the donefile (e.g. \`git checkout -- ${name}\`), fix the real failures, then finish again. A deliberate donefile edit must be repaired and blessed by a human with \`npx donegate baseline\`.`,
            ].join('\n'),
          giveUp: (bounces) =>
            `donegate: ✗ ${name} still does not parse after ${bounces} bounce${bounces > 1 ? 's' : ''} — giving up and allowing the stop: ${msg}`,
        });
      }
    }
    // A broken DONE.md should surface to the user, not silently allow stops —
    // but blocking the agent forever on a config typo is worse. Warn and allow.
    return { stdout: null, stderr: `donegate: ${msg} — allowing stop`, exitCode: 0 };
  }

  // Always verify — the receipt should reflect reality even when we've stopped
  // blocking. We give up on bouncing, never on checking. Subagent boundaries
  // run guards only: a tamper scan is cheap enough to pay per subagent, a test
  // suite is not — checks belong to the terminal stop.
  const summary = await verify({
    cwd,
    config,
    via: mode.subagent ? 'subagent' : agent,
    noChecks: mode.subagent,
  });

  if (summary.exitCode === 0) {
    const state = loadState(config.root);
    if (state.sessions[stateKey]) {
      delete state.sessions[stateKey];
      saveState(config.root, state);
    }
    return {
      stdout: null,
      stderr: mode.subagent
        ? `donegate: ✓ subagent boundary clean — guards pass (receipt: ${path.join(DONEGATE_DIR, 'receipts', 'latest.json')})`
        : `donegate: ✓ DONE — ${summary.receipt.checks.length} checks passed, guards clean (receipt: ${path.join(DONEGATE_DIR, 'receipts', 'latest.json')})`,
      exitCode: 0,
    };
  }

  return bounceOrGiveUp({
    agent,
    root: config.root,
    sessionId: stateKey,
    maxBounces: config.gate.max_bounces,
    // Progress = strictly fewer failing checks + tripped guards than the
    // session's best so far; progress refreshes the bounce budget.
    score: summary.checksFailed + summary.guardsFailed,
    reason: (attempt) => buildReason(summary, attempt, config.gate.max_bounces),
    giveUp: (bounces) =>
      `donegate: ✗ still NOT DONE after ${bounces} bounce${bounces > 1 ? 's' : ''} — giving up and allowing the stop. The receipt is red: ${path.join(DONEGATE_DIR, 'receipts', 'latest.json')}`,
  });
}

/** SessionStart hook: record a fresh tamper baseline unless one already exists. */
export async function runBaselineHook(options: { ifMissing: boolean; quiet: boolean; cwd?: string }): Promise<HookOutcome> {
  const cwd = options.cwd ?? process.cwd();
  const found = findDonefile(cwd);
  if (!found) return { stdout: null, stderr: null, exitCode: 0 };

  try {
    const config = loadConfig(cwd);
    if (options.ifMissing && fs.existsSync(baselinePath(config.root))) {
      return { stdout: null, stderr: null, exitCode: 0 };
    }
    const baseline = await writeBaseline(config);
    const note = `donegate: baseline recorded (${Object.keys(baseline.test_files).length} test files)`;
    return { stdout: null, stderr: options.quiet ? null : note, exitCode: 0 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { stdout: null, stderr: options.quiet ? null : `donegate: ${msg}`, exitCode: 0 };
  }
}
