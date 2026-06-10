#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { verify } from './check.js';
import { DonefileError, findDonefile, loadConfig } from './donefile.js';
import { writeBaseline, baselinePath } from './baseline.js';
import { initDonefile } from './init.js';
import {
  detectAgents,
  ensureGitignore,
  installAgent,
  installCi,
  uninstallAgent,
  uninstallCi,
  type InstallTarget,
} from './install.js';
import { readStdin, runBaselineHook, runStopHook, type HookAgent } from './hooks.js';
import {
  loadLatestReceipt,
  renderCheckLine,
  renderGuardsSection,
  renderMarkdown,
  renderTerminal,
  renderVerdict,
} from './receipt.js';
import { bold, cyan, dim, green, red, yellow } from './ui.js';
import { VERSION } from './version.js';

const HELP = `
${bold('donegate')} ${dim('v' + VERSION)} — your agent says it's done. ${bold('DONE.md')} decides.

${bold('USAGE')}
  donegate <command> [options]

${bold('COMMANDS')}
  ${cyan('init')}                      create a DONE.md from your repo's stack
  ${cyan('check')}                     run the gate: every check + tamper guards
  ${cyan('install')} [target]          gate an agent: claude | codex | cursor | ci | all
  ${cyan('uninstall')} <target>        remove donegate hooks for a target
  ${cyan('run')} -- <command…>         gate any command: baseline → run it → check
  ${cyan('baseline')}                  snapshot tests + DONE.md for tamper detection
  ${cyan('receipt')}                   show the latest receipt (--md | --json)
  ${cyan('hook')} <agent>              hook entrypoint (called by agent stop hooks)

${bold('OPTIONS')}
  check:     --only <names>   run a subset (comma-separated)
             --no-guards      skip tamper guards
             --json           print the receipt as JSON
  install:   --global         install to ~/.claude, ~/.codex, or ~/.cursor
  baseline:  --if-missing     only record when no baseline exists
  all:       -h, --help, -V, --version

${bold('EXIT CODES')}
  0 done · 1 checks failed · 2 config error · 3 guards tripped

${bold('QUICKSTART')}
  ${dim('$')} npx donegate init && npx donegate install
  ${dim(`— from then on, your agents can't say "done" unless it's true.`)}

${dim('docs: https://github.com/intrepideai/donegate')}
`;

function fail(message: string, code = 2): never {
  process.stderr.write(red(`donegate: ${message}`) + '\n');
  process.exit(code);
}

interface Flags {
  positional: string[];
  bool: Set<string>;
  values: Map<string, string>;
}

function parseFlags(argv: string[], valueFlags: string[] = []): Flags {
  const flags: Flags = { positional: [], bool: new Set(), values: new Map() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') {
      flags.positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (valueFlags.includes(name)) {
        const value = argv[++i];
        if (value === undefined) fail(`--${name} needs a value`);
        flags.values.set(name, value);
      } else {
        flags.bool.add(name);
      }
    } else if (arg.startsWith('-') && arg.length > 1) {
      flags.bool.add(arg.slice(1));
    } else {
      flags.positional.push(arg);
    }
  }
  return flags;
}

async function cmdInit(argv: string[]): Promise<number> {
  const flags = parseFlags(argv);
  const cwd = process.cwd();
  const result = initDonefile(cwd, flags.bool.has('force'));
  if (!result.created) {
    process.stdout.write(
      yellow('DONE.md already exists') + dim(' — use --force to overwrite, or edit it directly.\n'),
    );
    return 0;
  }
  process.stdout.write(bold(green('✓ created DONE.md')) + '\n\n');
  if (result.detection.checks.length > 0) {
    process.stdout.write(dim(`detected: ${result.detection.stack.join(', ')}`) + '\n');
    for (const check of result.detection.checks) {
      process.stdout.write(`  ${green('•')} ${check.name} ${dim('— ' + check.run)}\n`);
    }
  } else {
    process.stdout.write(
      yellow('▲ no stack detected') + ' — DONE.md contains a failing placeholder. Edit it.\n',
    );
  }
  process.stdout.write(
    '\n' +
      bold('next:') +
      '\n' +
      `  ${dim('$')} donegate check          ${dim('# run the gate yourself')}\n` +
      `  ${dim('$')} donegate install        ${dim('# gate your coding agents')}\n`,
  );
  return 0;
}

async function cmdCheck(argv: string[]): Promise<number> {
  const flags = parseFlags(argv, ['only']);
  const json = flags.bool.has('json');
  const quiet = flags.bool.has('quiet');
  const only = flags.values.get('only')?.split(',').map((s) => s.trim()).filter(Boolean);

  const config = loadConfig(process.cwd());
  if (only) {
    const known = new Set(config.checks.map((c) => c.name));
    for (const name of only) {
      if (!known.has(name)) fail(`unknown check "${name}" (have: ${[...known].join(', ')})`);
    }
  }

  if (!json && !quiet) {
    process.stdout.write(
      '\n' + bold(`donegate ${dim('v' + VERSION)}`) + ` — ${path.relative(process.cwd(), config.sourcePath) || 'DONE.md'}\n\n`,
    );
  }

  const summary = await verify({
    cwd: process.cwd(),
    config,
    only,
    noGuards: flags.bool.has('no-guards'),
    via: 'cli',
    onCheckResult: (result) => {
      if (!json && !quiet) process.stdout.write(renderCheckLine(result) + '\n');
    },
  });

  if (json) {
    process.stdout.write(JSON.stringify(summary.receipt, null, 2) + '\n');
  } else if (quiet) {
    process.stdout.write(renderVerdict(summary.receipt) + '\n');
  } else {
    const guards = renderGuardsSection(summary.receipt);
    if (guards !== '') process.stdout.write(guards + '\n');
    process.stdout.write(renderVerdict(summary.receipt) + '\n');
  }
  return summary.exitCode;
}

async function cmdInstall(argv: string[]): Promise<number> {
  const flags = parseFlags(argv);
  const global = flags.bool.has('global');
  const cwd = process.cwd();
  const found = findDonefile(cwd);
  const root = found?.root ?? cwd;

  const requested = (flags.positional[0] ?? 'all') as InstallTarget | 'all';
  const valid = ['claude', 'codex', 'cursor', 'ci', 'all'];
  if (!valid.includes(requested)) fail(`unknown target "${requested}" (use: ${valid.join(' | ')})`);

  if (!found) {
    process.stdout.write(
      yellow('▲ no DONE.md found') + dim(' — installing anyway; the hooks are no-ops until you run `donegate init`.\n'),
    );
  }

  let targets: InstallTarget[];
  if (requested === 'all') {
    const agents = detectAgents(root);
    if (agents.length === 0) {
      fail('no coding agents detected (.claude/.codex/.cursor). Name one explicitly: donegate install claude');
    }
    targets = agents;
  } else {
    targets = [requested];
  }

  for (const target of targets) {
    const result = target === 'ci' ? installCi(root) : installAgent(target, root, global);
    const rel = path.relative(cwd, result.file) || result.file;
    const icon = result.action === 'already-installed' ? yellow('•') : green('✓');
    const verb = result.action === 'already-installed' ? 'already gated' : 'gated';
    process.stdout.write(`${icon} ${bold(target)} ${verb} ${dim('— ' + rel)}\n`);
  }

  if (found) {
    try {
      const config = loadConfig(root);
      await writeBaseline(config);
      process.stdout.write(dim(`✓ baseline recorded (tamper guards armed)\n`));
    } catch {
      // donefile broken — init/check will surface it
    }
  }
  if (ensureGitignore(root)) {
    process.stdout.write(dim('✓ added .donegate/ to .gitignore\n'));
  }
  process.stdout.write(
    '\n' + dim('From now on, finishing in these agents runs the gate first. Try it: ask your agent to "wrap up".') + '\n',
  );
  return 0;
}

async function cmdUninstall(argv: string[]): Promise<number> {
  const flags = parseFlags(argv);
  const target = flags.positional[0] as InstallTarget | undefined;
  if (!target || !['claude', 'codex', 'cursor', 'ci'].includes(target)) {
    fail('usage: donegate uninstall <claude | codex | cursor | ci> [--global]');
  }
  const cwd = process.cwd();
  const root = findDonefile(cwd)?.root ?? cwd;
  const result =
    target === 'ci' ? uninstallCi(root) : uninstallAgent(target, root, flags.bool.has('global'));
  if (!result) {
    process.stdout.write(yellow(`nothing to remove for ${target}`) + '\n');
  } else {
    process.stdout.write(green(`✓ removed donegate hooks for ${target}`) + dim(` — ${result.file}`) + '\n');
  }
  return 0;
}

async function cmdBaseline(argv: string[]): Promise<number> {
  const flags = parseFlags(argv);
  const outcome = await runBaselineHook({
    ifMissing: flags.bool.has('if-missing'),
    quiet: flags.bool.has('quiet'),
    cwd: process.cwd(),
  });
  if (outcome.stderr) process.stderr.write(outcome.stderr + '\n');
  if (!flags.bool.has('quiet') && !outcome.stderr) {
    const found = findDonefile(process.cwd());
    if (found && fs.existsSync(baselinePath(found.root))) {
      process.stdout.write(green('✓ baseline recorded') + dim(' — .donegate/baseline.json\n'));
    }
  }
  return outcome.exitCode;
}

async function cmdReceipt(argv: string[]): Promise<number> {
  const flags = parseFlags(argv);
  const found = findDonefile(process.cwd());
  if (!found) fail('no DONE.md found — nothing has been gated here.');
  const receipt = loadLatestReceipt(found.root);
  if (!receipt) fail('no receipt yet — run `donegate check` first.', 1);
  if (flags.bool.has('json')) {
    process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
  } else if (flags.bool.has('md')) {
    process.stdout.write(renderMarkdown(receipt) + '\n');
  } else {
    process.stdout.write(renderTerminal(receipt) + '\n');
  }
  return receipt.verdict === 'pass' ? 0 : 1;
}

async function cmdHook(argv: string[]): Promise<number> {
  const agent = argv[0] as HookAgent | undefined;
  if (!agent || !['claude', 'codex', 'cursor'].includes(agent)) {
    fail('usage: donegate hook <claude | codex | cursor>');
  }
  const stdin = await readStdin();
  const outcome = await runStopHook(agent, stdin);
  if (outcome.stdout) process.stdout.write(outcome.stdout + '\n');
  if (outcome.stderr) process.stderr.write(outcome.stderr + '\n');
  return outcome.exitCode;
}

async function cmdRun(argv: string[]): Promise<number> {
  const sep = argv.indexOf('--');
  const command = sep >= 0 ? argv.slice(sep + 1) : argv;
  if (command.length === 0) fail('usage: donegate run -- <command…>');

  const config = loadConfig(process.cwd());
  await writeBaseline(config);
  process.stdout.write(dim(`donegate: baseline recorded — running: ${command.join(' ')}\n`));

  const child = spawn(command[0]!, command.slice(1), { stdio: 'inherit', cwd: process.cwd() });
  const agentExit: number = await new Promise((resolve) => {
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', (err) => {
      process.stderr.write(red(`donegate: could not run "${command[0]}": ${err.message}`) + '\n');
      resolve(127);
    });
  });

  process.stdout.write('\n' + dim(`donegate: command exited ${agentExit} — running the gate`) + '\n');
  return cmdCheck([]);
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(HELP + '\n');
    process.exit(0);
  }
  if (command === '--version' || command === '-V' || command === 'version') {
    process.stdout.write(VERSION + '\n');
    process.exit(0);
  }

  try {
    let code: number;
    switch (command) {
      case 'init':
        code = await cmdInit(rest);
        break;
      case 'check':
        code = await cmdCheck(rest);
        break;
      case 'install':
        code = await cmdInstall(rest);
        break;
      case 'uninstall':
        code = await cmdUninstall(rest);
        break;
      case 'baseline':
        code = await cmdBaseline(rest);
        break;
      case 'receipt':
        code = await cmdReceipt(rest);
        break;
      case 'hook':
        code = await cmdHook(rest);
        break;
      case 'run':
        code = await cmdRun(rest);
        break;
      default:
        fail(`unknown command "${command}" — run \`donegate help\``);
    }
    process.exit(code);
  } catch (err) {
    if (err instanceof DonefileError) fail(err.message);
    throw err;
  }
}

void main();
