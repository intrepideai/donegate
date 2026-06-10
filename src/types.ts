/** A single shell-command check declared in DONE.md. */
export interface CheckDef {
  name: string;
  run: string;
  /** Seconds before the check is killed and marked `timeout`. */
  timeout: number;
}

/**
 * Guard enforcement level:
 *  - `true`  — findings fail the gate
 *  - `"warn"` — findings are reported but don't fail the gate
 *  - `false` — guard disabled
 */
export type GuardLevel = boolean | 'warn';

export interface GuardsConfig {
  no_done_edits: GuardLevel;
  no_deleted_tests: GuardLevel;
  no_new_skips: GuardLevel;
  no_disabled_lint: GuardLevel;
  no_new_todos: GuardLevel;
  no_debug_artifacts: GuardLevel;
  /** Glob patterns that identify test files. */
  test_globs: string[];
}

export interface GateConfig {
  /** How many times a stop hook will bounce the agent back before giving up. */
  max_bounces: number;
}

export interface DoneConfig {
  version: number;
  checks: CheckDef[];
  guards: GuardsConfig;
  gate: GateConfig;
  /** Directory containing the donefile — the gate's working directory. */
  root: string;
  /** Absolute path of the parsed donefile. */
  sourcePath: string;
}

export type CheckStatus = 'pass' | 'fail' | 'timeout' | 'error';

export interface CheckResult {
  name: string;
  run: string;
  status: CheckStatus;
  exitCode: number | null;
  durationMs: number;
  /** Last chunk of combined stdout+stderr (capped). */
  outputTail: string;
}

export interface GuardFinding {
  file: string;
  line?: number;
  snippet?: string;
  detail: string;
}

export type GuardStatus = 'pass' | 'fail' | 'warn' | 'skipped';

export interface GuardResult {
  name: string;
  status: GuardStatus;
  findings: GuardFinding[];
  note?: string;
}

export type BaselineKind = 'session' | 'head' | 'merge-base' | 'none';

export interface BaselineFileEntry {
  sha: string;
  tests: number;
  skips: number;
}

export interface Baseline {
  version: 1;
  created_at: string;
  /** Git HEAD when the baseline was taken (null outside git). */
  head: string | null;
  donefile_sha: string;
  donefile_path: string;
  test_files: Record<string, BaselineFileEntry>;
}

export interface ComparisonContext {
  kind: BaselineKind;
  /** Git ref the working tree is compared against (null when kind is `none`). */
  ref: string | null;
  baseline: Baseline | null;
  note?: string;
}

export interface ReceiptRepoInfo {
  root: string;
  git: boolean;
  head: string | null;
  branch: string | null;
  dirty: boolean;
}

export interface ReceiptDiffStat {
  files_changed: number;
  insertions: number;
  deletions: number;
}

export interface Receipt {
  donegate: string;
  schema: 1;
  verdict: 'pass' | 'fail';
  started_at: string;
  finished_at: string;
  duration_ms: number;
  repo: ReceiptRepoInfo;
  donefile: string;
  baseline: { kind: BaselineKind; ref: string | null };
  diff: ReceiptDiffStat | null;
  checks: CheckResult[];
  guards: GuardResult[];
  /** Which surface produced the receipt. */
  via: 'cli' | 'claude' | 'codex' | 'cursor' | 'run';
  /** sha256 of the receipt body (excluding this field). */
  receipt_sha: string;
}

export interface CheckRunSummary {
  receipt: Receipt;
  checksFailed: number;
  guardsFailed: number;
  guardsWarned: number;
  exitCode: number;
}
