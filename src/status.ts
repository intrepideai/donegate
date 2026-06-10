import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findDonefile, loadConfig } from './donefile.js';
import { baselinePath } from './baseline.js';
import { loadLatestReceipt } from './receipt.js';
import { bold, cyan, dim, green, ms, red, yellow } from './ui.js';
import { VERSION } from './version.js';
import type { Baseline } from './types.js';

function fileHasDonegateHook(file: string): boolean {
  try {
    return fs.readFileSync(file, 'utf8').includes('donegate hook');
  } catch {
    return false;
  }
}

function agentStatus(root: string): string[] {
  const home = os.homedir();
  const targets: Array<{ name: string; project: string; global: string }> = [
    {
      name: 'claude',
      project: path.join(root, '.claude', 'settings.json'),
      global: path.join(home, '.claude', 'settings.json'),
    },
    {
      name: 'codex',
      project: path.join(root, '.codex', 'hooks.json'),
      global: path.join(home, '.codex', 'hooks.json'),
    },
    {
      name: 'cursor',
      project: path.join(root, '.cursor', 'hooks.json'),
      global: path.join(home, '.cursor', 'hooks.json'),
    },
  ];
  return targets.map(({ name, project, global: g }) => {
    if (fileHasDonegateHook(project)) return `${green('✓')} ${name} ${dim('(project)')}`;
    if (fileHasDonegateHook(g)) return `${green('✓')} ${name} ${dim('(global)')}`;
    return `${dim('✗')} ${dim(name)}`;
  });
}

function age(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 'unknown age';
  const delta = Date.now() - t;
  if (delta < 0) return 'just now';
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  return `${Math.round(delta / 86_400_000)}d ago`;
}

export function renderStatus(cwd: string): { text: string; exitCode: number } {
  const out: string[] = [];
  out.push('');
  out.push(bold(`donegate ${dim('v' + VERSION)} — status`));
  out.push('');

  const found = findDonefile(cwd);
  if (!found) {
    out.push(` ${yellow('▲')} no DONE.md found — run ${cyan('donegate init')}`);
    out.push('');
    return { text: out.join('\n'), exitCode: 1 };
  }

  const root = found.root;
  try {
    const config = loadConfig(cwd);
    const guardLevels = Object.entries(config.guards)
      .filter(([k]) => k !== 'test_globs')
      .map(([, v]) => v);
    const failCount = guardLevels.filter((v) => v === true).length;
    const warnCount = guardLevels.filter((v) => v === 'warn').length;
    out.push(
      ` ${green('✓')} donefile   ${path.relative(cwd, config.sourcePath) || path.basename(config.sourcePath)} ` +
        dim(`— ${config.checks.length} check${config.checks.length === 1 ? '' : 's'} (${config.checks.map((c) => c.name).join(', ')}), guards: ${failCount} fail / ${warnCount} warn, max_bounces ${config.gate.max_bounces}`),
    );
  } catch (err) {
    out.push(` ${red('✗')} donefile   ${err instanceof Error ? err.message : String(err)}`);
    out.push('');
    return { text: out.join('\n'), exitCode: 2 };
  }

  try {
    const raw = fs.readFileSync(baselinePath(root), 'utf8');
    const baseline = JSON.parse(raw) as Baseline;
    out.push(
      ` ${green('✓')} baseline   ${dim(`recorded ${age(baseline.created_at)} — ${Object.keys(baseline.test_files).length} test files${baseline.head ? `, HEAD ${baseline.head.slice(0, 8)}` : ''}`)}`,
    );
  } catch {
    out.push(` ${yellow('▲')} baseline   ${dim('none recorded — guards will compare against git (run `donegate baseline`)')}`);
  }

  out.push(` ${dim('·')} agents     ${agentStatus(root).join('   ')}`);

  const ciFile = path.join(root, '.github', 'workflows', 'donegate.yml');
  out.push(
    fs.existsSync(ciFile)
      ? ` ${green('✓')} ci         ${dim('.github/workflows/donegate.yml')}`
      : ` ${dim('✗')} ${dim('ci         not installed — `donegate install ci`')}`,
  );

  const receipt = loadLatestReceipt(root);
  if (receipt) {
    const verdict =
      receipt.verdict === 'pass'
        ? green(`✓ DONE`)
        : red(`✗ NOT DONE`);
    out.push(
      ` ${dim('·')} receipt    ${verdict} ${dim(`${age(receipt.finished_at)} via ${receipt.via} (${ms(receipt.duration_ms)}) — ${receipt.receipt_sha.slice(0, 12)}`)}`,
    );
  } else {
    out.push(` ${dim('·')} receipt    ${dim('none yet — run `donegate check`')}`);
  }

  out.push('');
  return { text: out.join('\n'), exitCode: 0 };
}
