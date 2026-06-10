import type { CheckRunSummary, DoneConfig, Receipt } from './types.js';
import { loadConfig } from './donefile.js';
import { resolveComparison, runGuards } from './guards.js';
import { runChecks } from './runner.js';
import { buildReceipt, writeReceipt } from './receipt.js';
import type { CheckResult } from './types.js';

export interface CheckOptions {
  cwd?: string;
  /** Run only these named checks (guards still run). */
  only?: string[];
  /** Skip tamper guards entirely. */
  noGuards?: boolean;
  via?: Receipt['via'];
  onCheckResult?: (result: CheckResult, index: number) => void;
  /** Pre-loaded config (skips discovery). */
  config?: DoneConfig;
}

/**
 * The whole gate: load DONE.md, run every check, run the guards,
 * write a receipt, return the verdict.
 *
 * Exit-code conventions (used by the CLI):
 *   0 — done
 *   1 — checks failed
 *   2 — configuration / usage error (thrown DonefileError)
 *   3 — checks passed but a tamper guard tripped
 */
export async function verify(options: CheckOptions = {}): Promise<CheckRunSummary> {
  const cwd = options.cwd ?? process.cwd();
  const config = options.config ?? loadConfig(cwd);
  const startedAt = new Date();

  const comparison = await resolveComparison(config);

  const checks = await runChecks(config.checks, config.root, options.onCheckResult, options.only);

  const guards = options.noGuards ? [] : await runGuards(config, comparison);

  const receipt = await buildReceipt({
    config,
    comparison,
    checks,
    guards,
    startedAt,
    via: options.via ?? 'cli',
  });
  writeReceipt(config.root, receipt);

  const checksFailed = checks.filter((c) => c.status !== 'pass').length;
  const guardsFailed = guards.filter((g) => g.status === 'fail').length;
  const guardsWarned = guards.filter((g) => g.status === 'warn').length;

  const exitCode = checksFailed > 0 ? 1 : guardsFailed > 0 ? 3 : 0;

  return { receipt, checksFailed, guardsFailed, guardsWarned, exitCode };
}
