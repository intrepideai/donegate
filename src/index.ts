/**
 * donegate — programmatic API.
 *
 * Most users want the CLI (`npx donegate`). This module exists for tooling
 * that wants to run the gate or read receipts in-process.
 */

export { verify, type CheckOptions } from './check.js';
export { loadConfig, parseDonefileSource, findDonefile, extractYamlBlock, DonefileError } from './donefile.js';
export { runGuards, resolveComparison } from './guards.js';
export { createBaseline, writeBaseline, loadBaseline } from './baseline.js';
export { buildReceipt, loadLatestReceipt, renderMarkdown, renderTerminal } from './receipt.js';
export { buildReason, runStopHook, runBaselineHook } from './hooks.js';
export { detectStack, renderDonefile, initDonefile } from './init.js';
export { parseYaml, YamlError } from './yaml.js';
export { VERSION } from './version.js';
export type {
  Baseline,
  CheckDef,
  CheckResult,
  CheckRunSummary,
  ComparisonContext,
  DoneConfig,
  GateConfig,
  GuardFinding,
  GuardLevel,
  GuardResult,
  GuardsConfig,
  Receipt,
} from './types.js';
