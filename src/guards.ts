import fs from 'node:fs';
import path from 'node:path';
import type {
  Baseline,
  ComparisonContext,
  DoneConfig,
  GuardFinding,
  GuardLevel,
  GuardResult,
} from './types.js';
import {
  addedLines,
  changedFiles,
  defaultBranchBase,
  head,
  isDirty,
  isGitRepo,
  refExists,
  type AddedLine,
} from './git.js';
import { countTests, loadBaseline, makeTestFileMatcher, sha256 } from './baseline.js';

/**
 * Guards are donegate's tamper detection: deterministic, diff-based checks that
 * catch the classic ways a coding agent "passes" a gate without doing the work —
 * skipping tests, deleting tests, silencing the linter, or editing DONE.md itself.
 */

const SKIP_PATTERNS: Array<{ re: RegExp; what: string }> = [
  { re: /\b(?:it|test|describe)\.(?:skip|todo|failing)\b/, what: 'test marked as skipped' },
  { re: /\b(?:it|test|describe)\.only\b/, what: '.only narrows the suite to a subset' },
  { re: /\bx(?:it|describe|test)\s*\(/, what: 'test disabled with x-prefix' },
  { re: /@pytest\.mark\.(?:skip|skipif|xfail)\b/, what: 'pytest skip/xfail marker' },
  { re: /\bpytest\.skip\(/, what: 'pytest.skip() call' },
  { re: /\bunittest\.skip/, what: 'unittest skip decorator' },
  { re: /\bt\.Skip(?:f|Now)?\(/, what: 'Go test skip' },
  { re: /#\[ignore\b/, what: 'Rust #[ignore] attribute' },
  { re: /@(?:Disabled|Ignore)\b/, what: 'JUnit disabled annotation' },
  { re: /^\s*x(?:it|describe|specify)\s+['"]/, what: 'RSpec disabled example' },
  { re: /@(?:module)?tag\s+:skip\b/, what: 'ExUnit skip tag' },
  { re: /\[\s*(?:Fact|Theory)\s*\(\s*Skip\s*=/, what: 'xUnit Skip attribute' },
  { re: /markTestSkipped|markTestIncomplete/, what: 'PHPUnit test skipped' },
  { re: /XCTSkip(?:If|Unless)?\(/, what: 'XCTest skip' },
];

const LINT_DISABLE_PATTERNS: Array<{ re: RegExp; what: string }> = [
  { re: /eslint-disable/, what: 'eslint-disable' },
  { re: /biome-ignore/, what: 'biome-ignore' },
  { re: /@ts-(?:ignore|nocheck|expect-error)\b/, what: 'TypeScript suppression' },
  { re: /(?:^|\s)#\s*noqa\b/, what: 'noqa' },
  { re: /#\s*type:\s*ignore\b/, what: 'mypy type: ignore' },
  { re: /#\s*pylint:\s*disable/, what: 'pylint disable' },
  { re: /\/\/\s*nolint\b|\/\/nolint\b/, what: 'golangci nolint' },
  { re: /#!?\[allow\(/, what: 'Rust #[allow(...)]' },
  { re: /@SuppressWarnings\b/, what: '@SuppressWarnings' },
  { re: /rubocop:disable/, what: 'rubocop:disable' },
  { re: /#pragma warning disable/, what: '#pragma warning disable' },
  { re: /phpcs:ignore|@codingStandardsIgnore/, what: 'phpcs suppression' },
  { re: /phpstan-ignore/, what: 'phpstan suppression' },
  { re: /credo:disable/, what: 'credo:disable' },
  { re: /swiftlint:disable/, what: 'swiftlint:disable' },
  { re: /deno-lint-ignore/, what: 'deno-lint-ignore' },
];

const TODO_PATTERN = /\b(?:TODO|FIXME|HACK|XXX)\b/;

const DEBUG_PATTERNS: Array<{ re: RegExp; what: string }> = [
  { re: /\bconsole\.(?:log|debug)\s*\(/, what: 'console.log left behind' },
  { re: /^\s*debugger\s*;?\s*$/, what: 'debugger statement' },
  { re: /\bbreakpoint\(\)/, what: 'breakpoint() call' },
  { re: /\bpdb\.set_trace\(\)/, what: 'pdb.set_trace()' },
  { re: /\bbinding\.pry\b/, what: 'binding.pry' },
  { re: /\bdbg!\(/, what: 'dbg! macro' },
];

function snippet(text: string): string {
  const t = text.trim();
  return t.length > 120 ? t.slice(0, 117) + '...' : t;
}

/**
 * Decide what the working tree should be compared against, in order of preference:
 *  1. a session baseline recorded by `donegate baseline` (hooks do this automatically)
 *  2. HEAD, when there is uncommitted work
 *  3. merge-base with the default branch, when the tree is clean
 */
export async function resolveComparison(config: DoneConfig): Promise<ComparisonContext> {
  const root = config.root;
  const inGit = await isGitRepo(root);
  const baseline = loadBaseline(root);

  if (baseline) {
    if (baseline.head && inGit && (await refExists(baseline.head, root))) {
      return { kind: 'session', ref: baseline.head, baseline };
    }
    return {
      kind: 'session',
      ref: null,
      baseline,
      note: inGit
        ? 'baseline commit no longer exists; falling back to snapshot-only comparison'
        : 'not a git repo; using snapshot-only comparison',
    };
  }

  if (!inGit) {
    return { kind: 'none', ref: null, baseline: null, note: 'not a git repo and no baseline recorded' };
  }

  if (await isDirty(root)) {
    const ref = await head(root);
    return ref
      ? { kind: 'head', ref, baseline: null }
      : { kind: 'none', ref: null, baseline: null, note: 'repository has no commits yet' };
  }

  const base = await defaultBranchBase(root);
  if (base) return { kind: 'merge-base', ref: base, baseline: null };

  return {
    kind: 'none',
    ref: null,
    baseline: null,
    note: 'clean tree with nothing to compare against (no baseline, no diverging default branch)',
  };
}

interface GuardInputs {
  config: DoneConfig;
  comparison: ComparisonContext;
  added: Map<string, AddedLine[]>;
  deletedPaths: string[];
  /** Tracked files that were modified (not added) since the comparison point. */
  modifiedPaths: string[];
  /** oldPath → newPath for renames, so "moved" is never reported as "deleted". */
  renames: Map<string, string>;
}

async function collectInputs(config: DoneConfig, comparison: ComparisonContext): Promise<GuardInputs> {
  let added = new Map<string, AddedLine[]>();
  let deletedPaths: string[] = [];
  let modifiedPaths: string[] = [];
  const renames = new Map<string, string>();

  if (comparison.ref) {
    added = await addedLines(comparison.ref, config.root);
    const changed = await changedFiles(comparison.ref, config.root);
    deletedPaths = changed.filter((c) => c.status === 'D').map((c) => c.path);
    modifiedPaths = changed.filter((c) => c.status === 'M' || c.status === 'R').map((c) => c.path);
    for (const c of changed) {
      if (c.status === 'R' && c.oldPath) renames.set(c.oldPath, c.path);
    }
  }
  return { config, comparison, added, deletedPaths, modifiedPaths, renames };
}

/** Files guards never line-scan: the donefile itself, donegate state, and prose/config formats. */
function makeMetaFileMatcher(donefileRel: string): (file: string) => boolean {
  return (file: string) =>
    file === donefileRel ||
    file.startsWith('.donegate/') ||
    /\.(?:md|markdown|rst|txt)$/i.test(file);
}

function makeResult(name: string, level: GuardLevel, findings: GuardFinding[], note?: string): GuardResult {
  if (level === false) return { name, status: 'skipped', findings: [], note: 'disabled in DONE.md' };
  if (findings.length === 0) return { name, status: 'pass', findings: [], note };
  return { name, status: level === 'warn' ? 'warn' : 'fail', findings, note };
}

function skippedAll(config: DoneConfig, note: string): GuardResult[] {
  const names = [
    'no_done_edits',
    'no_deleted_tests',
    'no_new_skips',
    'no_disabled_lint',
    'no_new_todos',
    'no_debug_artifacts',
  ] as const;
  return names
    .filter((n) => config.guards[n] !== false)
    .map((name) => ({ name, status: 'skipped' as const, findings: [], note }));
}

export async function runGuards(config: DoneConfig, comparison: ComparisonContext): Promise<GuardResult[]> {
  if (comparison.kind === 'none') {
    return skippedAll(config, comparison.note ?? 'nothing to compare against');
  }

  const inputs = await collectInputs(config, comparison);
  const isTestFile = makeTestFileMatcher(config.guards.test_globs);
  const donefileRel = path.relative(config.root, config.sourcePath).split(path.sep).join('/');
  const isMetaFile = makeMetaFileMatcher(donefileRel);
  const results: GuardResult[] = [];
  const baseline = comparison.baseline;

  // ── no_done_edits ──────────────────────────────────────────────────────────
  {
    const findings: GuardFinding[] = [];
    const rel = donefileRel;
    if (baseline) {
      try {
        const current = sha256(fs.readFileSync(config.sourcePath));
        if (current !== baseline.donefile_sha) {
          findings.push({
            file: rel,
            detail: `${rel} was modified after the baseline was taken — the definition of done is not the agent's to edit`,
          });
        }
      } catch {
        findings.push({ file: rel, detail: `${rel} is missing — it existed when the baseline was taken` });
      }
    } else if (inputs.modifiedPaths.includes(rel) || inputs.deletedPaths.includes(rel)) {
      // A brand-new DONE.md is someone creating the gate, not tampering with it —
      // only flag modifications and deletions when we have no session baseline.
      findings.push({
        file: rel,
        detail: `${rel} changed in this diff — the definition of done is not the agent's to edit`,
      });
    }
    results.push(makeResult('no_done_edits', config.guards.no_done_edits, findings));
  }

  // ── no_deleted_tests ───────────────────────────────────────────────────────
  {
    const findings: GuardFinding[] = [];
    const deletedTestFiles = inputs.deletedPaths.filter(isTestFile);
    for (const file of deletedTestFiles) {
      findings.push({ file, detail: 'test file deleted' });
    }
    if (baseline) {
      for (const [file, entry] of Object.entries(baseline.test_files)) {
        // Follow renames: a moved test file is compared at its new home.
        const currentPath = fs.existsSync(path.join(config.root, file))
          ? file
          : inputs.renames.get(file);
        if (!currentPath) {
          if (!deletedTestFiles.includes(file)) {
            findings.push({ file, detail: 'test file deleted since the baseline was taken' });
          }
          continue;
        }
        if (entry.tests > 0) {
          try {
            const counts = countTests(currentPath, fs.readFileSync(path.join(config.root, currentPath), 'utf8'));
            if (counts.tests < entry.tests) {
              findings.push({
                file: currentPath,
                detail: `test count dropped from ${entry.tests} to ${counts.tests} since the baseline`,
              });
            }
          } catch {
            // unreadable — ignore
          }
        }
      }
    }
    results.push(makeResult('no_deleted_tests', config.guards.no_deleted_tests, findings));
  }

  // ── no_new_skips ───────────────────────────────────────────────────────────
  {
    const findings: GuardFinding[] = [];
    for (const [file, lines] of inputs.added) {
      if (!isTestFile(file)) continue;
      for (const { line, text } of lines) {
        for (const { re, what } of SKIP_PATTERNS) {
          if (re.test(text)) {
            findings.push({ file, line, snippet: snippet(text), detail: what });
            break;
          }
        }
      }
    }
    if (baseline) {
      for (const [file, entry] of Object.entries(baseline.test_files)) {
        const currentPath = fs.existsSync(path.join(config.root, file))
          ? file
          : inputs.renames.get(file);
        if (!currentPath) continue;
        try {
          const counts = countTests(currentPath, fs.readFileSync(path.join(config.root, currentPath), 'utf8'));
          if (counts.skips > entry.skips && !findings.some((f) => f.file === currentPath)) {
            findings.push({
              file: currentPath,
              detail: `skipped-test count rose from ${entry.skips} to ${counts.skips} since the baseline`,
            });
          }
        } catch {
          // ignore
        }
      }
    }
    results.push(makeResult('no_new_skips', config.guards.no_new_skips, findings));
  }

  // ── no_disabled_lint ───────────────────────────────────────────────────────
  {
    const findings: GuardFinding[] = [];
    for (const [file, lines] of inputs.added) {
      if (isMetaFile(file)) continue;
      for (const { line, text } of lines) {
        for (const { re, what } of LINT_DISABLE_PATTERNS) {
          if (re.test(text)) {
            findings.push({ file, line, snippet: snippet(text), detail: what });
            break;
          }
        }
      }
    }
    results.push(makeResult('no_disabled_lint', config.guards.no_disabled_lint, findings));
  }

  // ── no_new_todos ───────────────────────────────────────────────────────────
  {
    const findings: GuardFinding[] = [];
    for (const [file, lines] of inputs.added) {
      if (isMetaFile(file)) continue;
      for (const { line, text } of lines) {
        if (TODO_PATTERN.test(text)) {
          findings.push({ file, line, snippet: snippet(text), detail: 'TODO/FIXME introduced' });
        }
      }
    }
    results.push(makeResult('no_new_todos', config.guards.no_new_todos, findings));
  }

  // ── no_debug_artifacts ─────────────────────────────────────────────────────
  {
    const findings: GuardFinding[] = [];
    for (const [file, lines] of inputs.added) {
      if (isTestFile(file) || isMetaFile(file)) continue;
      for (const { line, text } of lines) {
        for (const { re, what } of DEBUG_PATTERNS) {
          if (re.test(text)) {
            findings.push({ file, line, snippet: snippet(text), detail: what });
            break;
          }
        }
      }
    }
    results.push(makeResult('no_debug_artifacts', config.guards.no_debug_artifacts, findings));
  }

  return results;
}

/** Re-export for consumers that want to inspect baselines. */
export type { Baseline };
