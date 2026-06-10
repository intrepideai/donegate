import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type InstallTarget = 'claude' | 'codex' | 'cursor' | 'ci';

export const HOOK_COMMANDS: Record<
  Exclude<InstallTarget, 'ci'>,
  { stop: string; baseline: string; subagentStop?: string }
> = {
  claude: {
    stop: 'npx -y donegate hook claude',
    baseline: 'npx -y donegate baseline --if-missing --quiet',
    // Guards-only tamper scan at every subagent boundary — fast (git diffs,
    // no checks), so fan-out workflows are gated per node, not just at the end.
    subagentStop: 'npx -y donegate hook claude --subagent',
  },
  codex: { stop: 'npx -y donegate hook codex', baseline: 'npx -y donegate baseline --if-missing --quiet' },
  cursor: { stop: 'npx -y donegate hook cursor', baseline: 'npx -y donegate baseline --if-missing --quiet' },
};

/**
 * Agents kill hooks after a default timeout (Claude Code: 60s) — far too short
 * for a real test suite. Installed hooks carry an explicit generous timeout;
 * per-check limits in DONE.md are the real budget.
 */
const STOP_TIMEOUT_SECONDS = 1800;
const BASELINE_TIMEOUT_SECONDS = 120;
/** Guards only — no checks run — but big-repo git diffs and a cold npx need headroom. */
const SUBAGENT_TIMEOUT_SECONDS = 300;

export interface InstallResult {
  target: InstallTarget;
  file: string;
  action: 'installed' | 'already-installed' | 'updated';
}

function readJson(file: string): Record<string, unknown> {
  const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const data = JSON.parse(raw) as unknown;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error(`${file} does not contain a JSON object`);
  }
  return data as Record<string, unknown>;
}

function loadOrInit(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  try {
    return readJson(file);
  } catch (err) {
    throw new Error(
      `refusing to modify ${file}: ${err instanceof Error ? err.message : String(err)}. Fix the file and re-run.`,
    );
  }
}

function writeJson(file: string, data: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

/** Match only donegate's own hook commands, never a user's that mentions the word. */
function isDonegateCommand(value: unknown): boolean {
  return typeof value === 'string' && (value.includes('donegate hook') || value.includes('donegate baseline'));
}

type HookEntryList = Array<Record<string, unknown>>;

/** Claude Code and Codex share the same nested hook config shape. */
function mergeNestedHooks(
  config: Record<string, unknown>,
  eventName: string,
  command: string,
  timeout: number,
): boolean {
  const hooks = (config.hooks ?? {}) as Record<string, unknown>;
  const eventList = (Array.isArray(hooks[eventName]) ? hooks[eventName] : []) as HookEntryList;

  const exists = eventList.some((matcherEntry) => {
    const inner = matcherEntry?.hooks;
    return Array.isArray(inner) && inner.some((h) => isDonegateCommand((h as Record<string, unknown>)?.command));
  });
  if (exists) return false;

  eventList.push({ hooks: [{ type: 'command', command, timeout }] });
  hooks[eventName] = eventList;
  config.hooks = hooks;
  return true;
}

function removeNestedHooks(config: Record<string, unknown>, eventName: string): boolean {
  const hooks = config.hooks as Record<string, unknown> | undefined;
  if (!hooks || !Array.isArray(hooks[eventName])) return false;
  let removed = 0;
  const filtered = (hooks[eventName] as HookEntryList)
    .map((matcherEntry) => {
      const inner = matcherEntry?.hooks;
      if (!Array.isArray(inner)) return matcherEntry;
      const keep = inner.filter((h) => {
        const ours = isDonegateCommand((h as Record<string, unknown>)?.command);
        if (ours) removed++;
        return !ours;
      });
      return { ...matcherEntry, hooks: keep };
    })
    .filter((entry) => !Array.isArray(entry.hooks) || (entry.hooks as unknown[]).length > 0);
  if (removed === 0) return false;
  hooks[eventName] = filtered;
  if (filtered.length === 0) delete hooks[eventName];
  return true;
}

function configPath(target: Exclude<InstallTarget, 'ci'>, root: string, global: boolean): string {
  const home = os.homedir();
  switch (target) {
    case 'claude':
      return global ? path.join(home, '.claude', 'settings.json') : path.join(root, '.claude', 'settings.json');
    case 'codex':
      return global ? path.join(home, '.codex', 'hooks.json') : path.join(root, '.codex', 'hooks.json');
    case 'cursor':
      return global ? path.join(home, '.cursor', 'hooks.json') : path.join(root, '.cursor', 'hooks.json');
  }
}

export function installAgent(
  target: Exclude<InstallTarget, 'ci'>,
  root: string,
  global = false,
): InstallResult {
  const file = configPath(target, root, global);
  const config = loadOrInit(file);
  const commands = HOOK_COMMANDS[target];

  let changed = false;
  if (target === 'cursor') {
    if (config.version === undefined) config.version = 1;
    const hooks = (config.hooks ?? {}) as Record<string, unknown>;
    for (const [event, command, timeout] of [
      ['stop', commands.stop, STOP_TIMEOUT_SECONDS],
      ['sessionStart', commands.baseline, BASELINE_TIMEOUT_SECONDS],
    ] as const) {
      const list = (Array.isArray(hooks[event]) ? hooks[event] : []) as HookEntryList;
      if (!list.some((h) => isDonegateCommand(h?.command))) {
        list.push({ command, timeout });
        hooks[event] = list;
        changed = true;
      }
    }
    config.hooks = hooks;
  } else {
    changed = mergeNestedHooks(config, 'Stop', commands.stop, STOP_TIMEOUT_SECONDS) || changed;
    changed = mergeNestedHooks(config, 'SessionStart', commands.baseline, BASELINE_TIMEOUT_SECONDS) || changed;
    if (commands.subagentStop) {
      changed = mergeNestedHooks(config, 'SubagentStop', commands.subagentStop, SUBAGENT_TIMEOUT_SECONDS) || changed;
    }
  }

  if (!changed) return { target, file, action: 'already-installed' };
  writeJson(file, config);
  return { target, file, action: 'installed' };
}

export function uninstallAgent(
  target: Exclude<InstallTarget, 'ci'>,
  root: string,
  global = false,
): InstallResult | null {
  const file = configPath(target, root, global);
  if (!fs.existsSync(file)) return null;
  const config = loadOrInit(file);

  let changed = false;
  if (target === 'cursor') {
    const hooks = config.hooks as Record<string, unknown> | undefined;
    if (hooks) {
      for (const event of ['stop', 'sessionStart']) {
        if (Array.isArray(hooks[event])) {
          const before = (hooks[event] as HookEntryList).length;
          hooks[event] = (hooks[event] as HookEntryList).filter((h) => !isDonegateCommand(h?.command));
          if ((hooks[event] as HookEntryList).length !== before) changed = true;
          if ((hooks[event] as HookEntryList).length === 0) delete hooks[event];
        }
      }
    }
  } else {
    for (const event of ['Stop', 'SessionStart', 'SubagentStop']) {
      if (removeNestedHooks(config, event)) changed = true;
    }
  }

  if (!changed) return null;
  writeJson(file, config);
  return { target, file, action: 'updated' };
}

const CI_MARKER = 'Installed by `donegate install ci`';

const CI_WORKFLOW = `# ${CI_MARKER} — https://github.com/intrepideai/donegate
# Runs the DONE.md gate on every pull request and posts the receipt as a comment.
name: donegate

on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Run the gate
        run: npx -y donegate check
      - name: Comment receipt on PR
        if: always()
        env:
          GH_TOKEN: \${{ github.token }}
          PR: \${{ github.event.pull_request.number }}
        run: |
          npx -y donegate receipt --md > /tmp/donegate-receipt.md 2>/dev/null \\
            || echo '_donegate: no receipt produced (gate failed before running checks)_' > /tmp/donegate-receipt.md
          gh pr comment "$PR" --edit-last --create-if-none --body-file /tmp/donegate-receipt.md \\
            || gh pr comment "$PR" --body-file /tmp/donegate-receipt.md \\
            || echo "donegate: could not comment on PR (insufficient permissions?)"
`;

export function installCi(root: string): InstallResult {
  const file = path.join(root, '.github', 'workflows', 'donegate.yml');
  if (fs.existsSync(file)) {
    return { target: 'ci', file, action: 'already-installed' };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, CI_WORKFLOW);
  return { target: 'ci', file, action: 'installed' };
}

export function uninstallCi(root: string): InstallResult | null {
  const file = path.join(root, '.github', 'workflows', 'donegate.yml');
  if (!fs.existsSync(file)) return null;
  if (!fs.readFileSync(file, 'utf8').includes(CI_MARKER)) return null;
  fs.unlinkSync(file);
  return { target: 'ci', file, action: 'updated' };
}

/** Make sure `.donegate/` (receipts, baselines, bounce state) stays out of git. */
export function ensureGitignore(root: string): boolean {
  const file = path.join(root, '.gitignore');
  const line = '.donegate/';
  if (fs.existsSync(file)) {
    const content = fs.readFileSync(file, 'utf8');
    if (content.split(/\r?\n/).some((l) => l.trim() === line || l.trim() === '.donegate')) return false;
    fs.writeFileSync(file, content.replace(/\n?$/, '\n') + line + '\n');
    return true;
  }
  fs.writeFileSync(file, line + '\n');
  return true;
}

/** Which agents look present (project- or user-level)? */
export function detectAgents(root: string): Array<Exclude<InstallTarget, 'ci'>> {
  const home = os.homedir();
  const found: Array<Exclude<InstallTarget, 'ci'>> = [];
  if (fs.existsSync(path.join(root, '.claude')) || fs.existsSync(path.join(home, '.claude'))) found.push('claude');
  if (fs.existsSync(path.join(root, '.codex')) || fs.existsSync(path.join(home, '.codex'))) found.push('codex');
  if (fs.existsSync(path.join(root, '.cursor')) || fs.existsSync(path.join(home, '.cursor'))) found.push('cursor');
  return found;
}
