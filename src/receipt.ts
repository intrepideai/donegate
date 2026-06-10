import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  CheckResult,
  ComparisonContext,
  DoneConfig,
  GuardResult,
  Receipt,
  ReceiptRepoInfo,
} from './types.js';
import { DONEGATE_DIR } from './baseline.js';
import { branch, diffStat, head, isDirty, isGitRepo } from './git.js';
import { bold, dim, green, ms, red, statusSymbol, yellow } from './ui.js';
import { VERSION } from './version.js';

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}

export async function buildReceipt(args: {
  config: DoneConfig;
  comparison: ComparisonContext;
  checks: CheckResult[];
  guards: GuardResult[];
  startedAt: Date;
  via: Receipt['via'];
}): Promise<Receipt> {
  const { config, comparison, checks, guards, startedAt, via } = args;
  const finished = new Date();

  const inGit = await isGitRepo(config.root);
  const repo: ReceiptRepoInfo = {
    root: config.root,
    git: inGit,
    head: inGit ? await head(config.root) : null,
    branch: inGit ? await branch(config.root) : null,
    dirty: inGit ? await isDirty(config.root) : false,
  };

  const diff = comparison.ref ? await diffStat(comparison.ref, config.root) : null;

  const checksFailed = checks.some((c) => c.status !== 'pass');
  const guardsFailed = guards.some((g) => g.status === 'fail');

  const body: Omit<Receipt, 'receipt_sha'> = {
    donegate: VERSION,
    schema: 1,
    verdict: checksFailed || guardsFailed ? 'fail' : 'pass',
    started_at: startedAt.toISOString(),
    finished_at: finished.toISOString(),
    duration_ms: finished.getTime() - startedAt.getTime(),
    repo,
    donefile: path.relative(config.root, config.sourcePath).split(path.sep).join('/'),
    baseline: { kind: comparison.kind, ref: comparison.ref },
    diff,
    checks,
    guards,
    via,
  };

  const receipt_sha = crypto.createHash('sha256').update(stableStringify(body)).digest('hex');
  return { ...body, receipt_sha };
}

export function receiptDir(root: string): string {
  return path.join(root, DONEGATE_DIR, 'receipts');
}

export function writeReceipt(root: string, receipt: Receipt): string {
  const dir = receiptDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const latest = path.join(dir, 'latest.json');
  fs.writeFileSync(latest, JSON.stringify(receipt, null, 2) + '\n');

  const stamp = receipt.finished_at.replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(dir, `receipt-${stamp}.json`), JSON.stringify(receipt, null, 2) + '\n');

  // Keep the 20 most recent history files.
  const history = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('receipt-') && f.endsWith('.json'))
    .sort();
  for (const old of history.slice(0, Math.max(0, history.length - 20))) {
    try {
      fs.unlinkSync(path.join(dir, old));
    } catch {
      // ignore
    }
  }
  return latest;
}

export function loadLatestReceipt(root: string): Receipt | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(receiptDir(root), 'latest.json'), 'utf8')) as Receipt;
  } catch {
    return null;
  }
}

function lastLines(text: string, n: number): string {
  const lines = text.replace(/\s+$/, '').split('\n');
  return lines.slice(-n).join('\n');
}

export function renderCheckLine(check: CheckResult): string {
  const out: string[] = [];
  const time = dim(`(${ms(check.durationMs)})`);
  out.push(` ${statusSymbol(check.status)} ${check.name} ${time}`);
  if (check.status !== 'pass') {
    const reason =
      check.status === 'timeout'
        ? red(`timed out after ${ms(check.durationMs)}`)
        : check.status === 'error'
          ? red('could not run')
          : red(`exit ${check.exitCode}`);
    out.push(`   ${dim('$')} ${dim(check.run)} ${reason}`);
    const tail = lastLines(check.outputTail, 12);
    if (tail.trim() !== '') {
      out.push(
        tail
          .split('\n')
          .map((l) => dim('   │ ') + l)
          .join('\n'),
      );
    }
  }
  return out.join('\n');
}

export function renderGuardsSection(receipt: Receipt): string {
  const out: string[] = [];
  const activeGuards = receipt.guards.filter((g) => g.status !== 'skipped');
  if (activeGuards.length > 0) {
    out.push('');
    out.push(bold(' guards'));
    for (const guard of activeGuards) {
      out.push(` ${statusSymbol(guard.status)} ${guard.name}`);
      for (const f of guard.findings.slice(0, 8)) {
        const loc = f.line ? `${f.file}:${f.line}` : f.file;
        const head = guard.status === 'warn' ? yellow(loc) : red(loc);
        out.push(`   ${head} ${dim('—')} ${f.detail}`);
        if (f.snippet) out.push(`     ${dim(f.snippet)}`);
      }
      if (guard.findings.length > 8) {
        out.push(dim(`   … and ${guard.findings.length - 8} more`));
      }
    }
  }
  const skippedNote = receipt.guards.find((g) => g.status === 'skipped')?.note;
  if (activeGuards.length === 0 && skippedNote) {
    out.push('');
    out.push(dim(` guards skipped: ${skippedNote}`));
  }
  return out.join('\n');
}

export function renderVerdict(receipt: Receipt): string {
  const out: string[] = [];
  out.push('');
  const failedChecks = receipt.checks.filter((c) => c.status !== 'pass').length;
  const failedGuards = receipt.guards.filter((g) => g.status === 'fail').length;
  if (receipt.verdict === 'pass') {
    out.push(
      bold(green(` ✓ DONE — ${receipt.checks.length} checks passed, guards clean`)) +
        dim(` (${ms(receipt.duration_ms)})`),
    );
  } else {
    const parts: string[] = [];
    if (failedChecks > 0) parts.push(`${failedChecks} of ${receipt.checks.length} checks failed`);
    if (failedGuards > 0) parts.push(`${failedGuards} guard${failedGuards > 1 ? 's' : ''} tripped`);
    out.push(bold(red(` ✗ NOT DONE — ${parts.join(', ')}`)) + dim(` (${ms(receipt.duration_ms)})`));
  }
  out.push(dim(`   receipt: ${path.join(DONEGATE_DIR, 'receipts', 'latest.json')}`));
  out.push('');
  return out.join('\n');
}

export function renderTerminal(receipt: Receipt): string {
  const out: string[] = [];
  out.push('');
  out.push(bold(`donegate ${dim('v' + receipt.donegate)} — ${receipt.donefile}`));
  out.push('');
  for (const check of receipt.checks) {
    out.push(renderCheckLine(check));
  }
  const guards = renderGuardsSection(receipt);
  if (guards !== '') out.push(guards);
  out.push(renderVerdict(receipt));
  return out.join('\n');
}

export function renderMarkdown(receipt: Receipt): string {
  const out: string[] = [];
  const emoji = receipt.verdict === 'pass' ? '✅' : '❌';
  out.push(`### ${emoji} donegate: ${receipt.verdict === 'pass' ? 'DONE' : 'NOT DONE'}`);
  out.push('');
  out.push(`| check | status | time |`);
  out.push(`|---|---|---|`);
  for (const c of receipt.checks) {
    const icon = c.status === 'pass' ? '✅' : c.status === 'timeout' ? '⏱️' : '❌';
    const status = c.status === 'pass' ? 'pass' : c.status === 'fail' ? `fail (exit ${c.exitCode})` : c.status;
    out.push(`| \`${c.name}\` | ${icon} ${status} | ${ms(c.durationMs)} |`);
  }

  const failing = receipt.checks.filter((c) => c.status !== 'pass');
  for (const c of failing) {
    const tail = lastLines(c.outputTail, 20).trim();
    if (tail !== '') {
      out.push('');
      out.push(`<details><summary>output: <code>${c.name}</code></summary>`);
      out.push('');
      out.push('```');
      out.push(tail);
      out.push('```');
      out.push('</details>');
    }
  }

  const guardRows = receipt.guards.filter((g) => g.status === 'fail' || g.status === 'warn');
  if (guardRows.length > 0) {
    out.push('');
    out.push('#### 🛡 Guards');
    for (const g of guardRows) {
      const icon = g.status === 'fail' ? '🚨' : '⚠️';
      out.push(`- ${icon} **${g.name}**`);
      for (const f of g.findings.slice(0, 10)) {
        const loc = f.line ? `\`${f.file}:${f.line}\`` : `\`${f.file}\``;
        out.push(`  - ${loc} — ${f.detail}`);
      }
      if (g.findings.length > 10) out.push(`  - … and ${g.findings.length - 10} more`);
    }
  }

  out.push('');
  const base = receipt.baseline.ref ? `\`${receipt.baseline.ref.slice(0, 10)}\` (${receipt.baseline.kind})` : receipt.baseline.kind;
  const diff = receipt.diff
    ? ` · ${receipt.diff.files_changed} files, +${receipt.diff.insertions}/−${receipt.diff.deletions}`
    : '';
  out.push(
    `<sub>donegate v${receipt.donegate} · baseline ${base}${diff} · receipt \`${receipt.receipt_sha.slice(0, 16)}\`</sub>`,
  );
  return out.join('\n');
}
