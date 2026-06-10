import fs from 'node:fs';
import path from 'node:path';
import type { CheckRunSummary, DoneConfig, GuardFinding, Receipt } from './types.js';
import { findDonefile, loadConfig } from './donefile.js';
import { verify } from './check.js';
import { DONEGATE_DIR, baselinePath, writeBaseline } from './baseline.js';
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
  sessions: Record<string, { bounces: number; updated_at: string }>;
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
  // Prune sessions older than 24h so the file can't grow without bound.
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [id, entry] of Object.entries(state.sessions)) {
    if (new Date(entry.updated_at).getTime() < cutoff) delete state.sessions[id];
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

export async function runStopHook(agent: HookAgent, rawStdin: string): Promise<HookOutcome> {
  const payload = parsePayload(rawStdin);
  const cwd = resolveCwd(payload);

  // No DONE.md → never interfere. A globally-installed hook must be a no-op
  // in repos that haven't opted in.
  const found = findDonefile(cwd);
  if (!found) return { stdout: null, stderr: null, exitCode: 0 };

  // Cursor tells us how the turn ended; don't harass a user who hit ctrl-c.
  if (agent === 'cursor' && payload.status && payload.status !== 'completed') {
    return { stdout: null, stderr: null, exitCode: 0 };
  }

  let config: DoneConfig;
  try {
    config = loadConfig(cwd);
  } catch (err) {
    // A broken DONE.md should surface to the user, not silently allow stops —
    // but blocking the agent forever on a config typo is worse. Warn and allow.
    const msg = err instanceof Error ? err.message : String(err);
    return { stdout: null, stderr: `donegate: ${msg} — allowing stop`, exitCode: 0 };
  }

  const sessionId = payload.session_id ?? payload.conversation_id ?? 'default';
  const state = loadState(config.root);
  const bounces = state.sessions[sessionId]?.bounces ?? 0;

  // Always verify — the receipt should reflect reality even when we've stopped
  // blocking. We give up on bouncing, never on checking.
  const summary = await verify({ cwd, config, via: agent });

  if (summary.exitCode === 0) {
    if (state.sessions[sessionId]) {
      delete state.sessions[sessionId];
      saveState(config.root, state);
    }
    return {
      stdout: null,
      stderr: `donegate: ✓ DONE — ${summary.receipt.checks.length} checks passed, guards clean (receipt: ${path.join(DONEGATE_DIR, 'receipts', 'latest.json')})`,
      exitCode: 0,
    };
  }

  if (bounces >= config.gate.max_bounces) {
    return {
      stdout: null,
      stderr: `donegate: ✗ still NOT DONE after ${bounces} bounce${bounces > 1 ? 's' : ''} — giving up and allowing the stop. The receipt is red: ${path.join(DONEGATE_DIR, 'receipts', 'latest.json')}`,
      exitCode: 0,
    };
  }

  const bounce = bounces + 1;
  state.sessions[sessionId] = { bounces: bounce, updated_at: new Date().toISOString() };
  saveState(config.root, state);

  const reason = buildReason(summary, bounce, config.gate.max_bounces);

  if (agent === 'cursor') {
    return {
      stdout: JSON.stringify({ followup_message: reason }),
      stderr: null,
      exitCode: 0,
    };
  }

  // claude + codex share the decision/block contract.
  return {
    stdout: JSON.stringify({ decision: 'block', reason }),
    stderr: null,
    exitCode: 0,
  };
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
