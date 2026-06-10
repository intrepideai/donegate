import fs from 'node:fs';
import path from 'node:path';
import { parseYaml, YamlError } from './yaml.js';
import type { CheckDef, DoneConfig, GateConfig, GuardLevel, GuardsConfig } from './types.js';

export class DonefileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DonefileError';
  }
}

export const DEFAULT_TEST_GLOBS = [
  '**/*.test.*',
  '**/*.spec.*',
  '**/test_*.py',
  '**/*_test.py',
  '**/*_test.go',
  '**/*_test.rb',
  '**/*_test.exs',
  '**/*Test.java',
  '**/*Test.kt',
  '**/*Test.php',
  '**/*Tests.cs',
  '**/*Tests.swift',
  '**/tests/**',
  '**/__tests__/**',
  'test/**',
  'spec/**',
];

const DEFAULT_GUARDS: GuardsConfig = {
  no_done_edits: true,
  no_deleted_tests: true,
  no_new_skips: true,
  no_disabled_lint: true,
  no_new_todos: 'warn',
  no_debug_artifacts: 'warn',
  test_globs: DEFAULT_TEST_GLOBS,
  exclude: [],
};

/** Bounce budget used when there is no (readable) donefile to say otherwise. */
export const DEFAULT_MAX_BOUNCES = 3;

const DEFAULT_GATE: GateConfig = { max_bounces: DEFAULT_MAX_BOUNCES };

const CANDIDATES = ['DONE.md', 'done.yml', 'done.yaml', path.join('.donegate', 'done.yml')];

/** Walk upward from `cwd` looking for a donefile. */
export function findDonefile(cwd: string): { sourcePath: string; root: string } | null {
  let dir = path.resolve(cwd);
  while (true) {
    for (const candidate of CANDIDATES) {
      const p = path.join(dir, candidate);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        return { sourcePath: p, root: dir };
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Extract the first ```yaml fenced block from markdown. */
export function extractYamlBlock(markdown: string): { yaml: string; startLine: number } | null {
  const lines = markdown.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const fence = lines[i]!.trim();
    if (start === -1) {
      if (/^```\s*ya?ml\s*$/i.test(fence)) start = i + 1;
    } else if (/^```\s*$/.test(fence)) {
      return { yaml: lines.slice(start, i).join('\n'), startLine: start + 1 };
    }
  }
  return null;
}

function asGuardLevel(value: unknown, key: string): GuardLevel {
  if (value === true || value === false || value === 'warn') return value;
  if (value === 'off') return false;
  if (value === 'fail') return true;
  throw new DonefileError(
    `guards.${key} must be true, false, or "warn" (got ${JSON.stringify(value)})`,
  );
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function parseDonefileSource(source: string, sourcePath: string, root: string): DoneConfig {
  let yamlSource = source;
  if (sourcePath.toLowerCase().endsWith('.md')) {
    const block = extractYamlBlock(source);
    if (!block) {
      throw new DonefileError(
        `${path.basename(sourcePath)} has no \`\`\`yaml block. ` +
          'donegate reads its checks from the first yaml code block — run `donegate init` to see an example.',
      );
    }
    yamlSource = block.yaml;
  }

  let data: unknown;
  try {
    data = parseYaml(yamlSource);
  } catch (err) {
    if (err instanceof YamlError) {
      throw new DonefileError(`could not parse ${path.basename(sourcePath)}: ${err.message}`);
    }
    throw err;
  }

  if (!isRecord(data)) {
    throw new DonefileError(`${path.basename(sourcePath)} must define a yaml map with a "checks" list`);
  }

  const version = typeof data.version === 'number' ? data.version : 1;
  if (version !== 1) {
    throw new DonefileError(`unsupported donefile version ${version} (this donegate speaks version 1)`);
  }

  if (!Array.isArray(data.checks) || data.checks.length === 0) {
    throw new DonefileError(
      `${path.basename(sourcePath)} declares no checks. A definition of done with nothing to check is a vibe, not a definition.`,
    );
  }

  const checks: CheckDef[] = [];
  const seen = new Set<string>();
  for (const [idx, raw] of data.checks.entries()) {
    if (!isRecord(raw)) throw new DonefileError(`checks[${idx}] must be a map with "name" and "run"`);
    const name = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : null;
    const run = typeof raw.run === 'string' && raw.run.trim() !== '' ? raw.run.trim() : null;
    if (!name) throw new DonefileError(`checks[${idx}] is missing a "name"`);
    if (!run) {
      if (raw.run !== undefined && typeof raw.run !== 'string') {
        throw new DonefileError(
          `check "${name}": run must be a string command, got ${JSON.stringify(raw.run)} — quote it ("${String(raw.run)}") if that's really your command`,
        );
      }
      throw new DonefileError(`check "${name}" is missing a "run" command`);
    }
    if (seen.has(name)) throw new DonefileError(`duplicate check name "${name}"`);
    seen.add(name);
    let timeout = 600;
    if (raw.timeout !== undefined) {
      if (typeof raw.timeout !== 'number' || raw.timeout <= 0) {
        throw new DonefileError(`check "${name}": timeout must be a positive number of seconds`);
      }
      timeout = Math.min(raw.timeout, 3600);
    }
    checks.push({ name, run, timeout });
  }

  const guards: GuardsConfig = { ...DEFAULT_GUARDS, test_globs: [...DEFAULT_TEST_GLOBS], exclude: [] };
  if (data.guards !== undefined) {
    if (!isRecord(data.guards)) throw new DonefileError('"guards" must be a map');
    for (const [key, value] of Object.entries(data.guards)) {
      switch (key) {
        case 'no_done_edits':
        case 'no_deleted_tests':
        case 'no_new_skips':
        case 'no_disabled_lint':
        case 'no_new_todos':
        case 'no_debug_artifacts':
          guards[key] = asGuardLevel(value, key);
          break;
        case 'test_globs':
        case 'exclude':
          if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
            throw new DonefileError(`guards.${key} must be a list of glob strings`);
          }
          guards[key] = value as string[];
          break;
        default:
          throw new DonefileError(`unknown guard "${key}"`);
      }
    }
  }

  const gate: GateConfig = { ...DEFAULT_GATE };
  if (data.gate !== undefined) {
    if (!isRecord(data.gate)) throw new DonefileError('"gate" must be a map');
    if (data.gate.max_bounces !== undefined) {
      const n = data.gate.max_bounces;
      if (typeof n !== 'number' || n < 1 || n > 20) {
        throw new DonefileError('gate.max_bounces must be a number between 1 and 20');
      }
      gate.max_bounces = Math.floor(n);
    }
  }

  return { version: 1, checks, guards, gate, root, sourcePath };
}

export function loadConfig(cwd: string): DoneConfig {
  const found = findDonefile(cwd);
  if (!found) {
    throw new DonefileError(
      'no DONE.md found in this directory or any parent. Run `donegate init` to create one.',
    );
  }
  const source = fs.readFileSync(found.sourcePath, 'utf8');
  return parseDonefileSource(source, found.sourcePath, found.root);
}
