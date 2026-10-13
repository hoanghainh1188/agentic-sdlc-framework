// The result of one evaluation run (task L02, design/ADR-M78 §2.4, AC6). Numbers and codes only:
// never a prompt, task text, code, a diff or a path. Every result is checked before it is written,
// so a field that could carry text fails the run instead of reaching the report.
import fs from 'node:fs';
import path from 'node:path';

export interface RunResult {
  readonly schema: 1;
  readonly task_set: number;
  readonly task: string;
  readonly configuration: string;
  readonly model: string;
  readonly agent_version: string;
  /** SHA-256 of the instructions the agent read (AGENTS.md or the configuration's file). */
  readonly instructions_sha256: string;
  /** 1 … N. */
  readonly run: number;
  /** The runner's outcome and the run's status, as codes. */
  readonly outcome: string;
  readonly status: string;
  readonly stop_reason: string | null;
  /** The agent's change applied cleanly on the base in the scoring container. */
  readonly applied: boolean;
  /** Hidden tests passed and nothing broke: the task is resolved. */
  readonly resolved: boolean;
  readonly fail_to_pass_passed: boolean;
  readonly pass_to_pass_passed: boolean;
  /** The repository's checks passed on the agent's change (no second try). */
  readonly ci_passed: boolean;
  readonly scope_breach: boolean;
  readonly out_of_plan_files: number;
  /** ESLint messages on the files the agent changed. */
  readonly lint_findings: number;
  readonly diff_files: number;
  readonly diff_lines_added: number;
  readonly diff_lines_removed: number;
  readonly seconds: number;
  readonly iterations: number;
  readonly model_calls: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cached_input_tokens: number;
  /** Decimal string, 6 decimals (D-05 D6). */
  readonly cost_usd: string;
}

const CODE = /^[a-z][a-z0-9_.:-]{0,63}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const USD6 = /^[0-9]{1,12}\.[0-9]{6}$/;

const SPEC: Readonly<
  Record<keyof RunResult, 'count' | 'bool' | 'code' | 'code?' | 'name' | 'sha' | 'usd' | 'schema'>
> = {
  schema: 'schema',
  task_set: 'count',
  task: 'code',
  configuration: 'code',
  model: 'name',
  agent_version: 'name',
  instructions_sha256: 'sha',
  run: 'count',
  outcome: 'code',
  status: 'code',
  stop_reason: 'code?',
  applied: 'bool',
  resolved: 'bool',
  fail_to_pass_passed: 'bool',
  pass_to_pass_passed: 'bool',
  ci_passed: 'bool',
  scope_breach: 'bool',
  out_of_plan_files: 'count',
  lint_findings: 'count',
  diff_files: 'count',
  diff_lines_added: 'count',
  diff_lines_removed: 'count',
  seconds: 'count',
  iterations: 'count',
  model_calls: 'count',
  input_tokens: 'count',
  output_tokens: 'count',
  cached_input_tokens: 'count',
  cost_usd: 'usd',
};

/** The fields of a run result, in the report's order. */
export const RUN_RESULT_FIELDS = Object.keys(SPEC) as (keyof RunResult)[];

function valid(kind: (typeof SPEC)[keyof RunResult], value: unknown): boolean {
  switch (kind) {
    case 'schema':
      return value === 1;
    case 'count':
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    case 'bool':
      return typeof value === 'boolean';
    case 'code':
      return typeof value === 'string' && CODE.test(value);
    case 'code?':
      return value === null || (typeof value === 'string' && CODE.test(value));
    case 'name':
      return typeof value === 'string' && NAME.test(value);
    case 'sha':
      return typeof value === 'string' && SHA256.test(value);
    case 'usd':
      return typeof value === 'string' && USD6.test(value);
  }
}

/**
 * Checks a run result: exactly the declared fields, each in its format. Throws on anything else,
 * so no free text reaches a result file or the report.
 */
export function checkRunResult(value: unknown): RunResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('run result: not an object');
  }
  const record = value as Record<string, unknown>;
  const extra = Object.keys(record).filter((key) => !Object.hasOwn(SPEC, key));
  if (extra.length > 0) throw new TypeError(`run result: undeclared field ${extra.join(', ')}`);
  for (const field of RUN_RESULT_FIELDS) {
    if (!valid(SPEC[field], record[field])) throw new TypeError(`run result: bad field ${field}`);
  }
  if (record.resolved === true && !(record.fail_to_pass_passed && record.pass_to_pass_passed)) {
    throw new TypeError('run result: resolved needs both hidden test groups');
  }
  return record as unknown as RunResult;
}

/** `<out>/v<set>/<configuration>/<task>/run-<n>.json`. */
export function resultPath(
  out: string,
  key: { taskSet: number; configuration: string; task: string; run: number },
): string {
  return path.join(
    out,
    `v${String(key.taskSet)}`,
    key.configuration,
    key.task,
    `run-${String(key.run)}.json`,
  );
}

/** Writes a checked result atomically (a stopped evaluation never leaves half a file). */
export function writeRunResult(out: string, result: RunResult): string {
  const checked = checkRunResult(result);
  const file = resultPath(out, {
    taskSet: checked.task_set,
    configuration: checked.configuration,
    task: checked.task,
    run: checked.run,
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(checked, null, 2)}\n`, { mode: 0o644 });
  fs.renameSync(tmp, file);
  return file;
}

/** True when this run's result already exists and is valid: the evaluation skips it. */
export function hasRunResult(
  out: string,
  key: { taskSet: number; configuration: string; task: string; run: number },
): boolean {
  const file = resultPath(out, key);
  if (!fs.existsSync(file)) return false;
  try {
    checkRunResult(JSON.parse(fs.readFileSync(file, 'utf8')));
    return true;
  } catch {
    return false;
  }
}

/** Every valid result under `out` for one task set version (for the report, PR 3). */
export function readRunResults(out: string, taskSet: number): RunResult[] {
  const root = path.join(out, `v${String(taskSet)}`);
  if (!fs.existsSync(root)) return [];
  const results: RunResult[] = [];
  for (const configuration of fs.readdirSync(root)) {
    const configDir = path.join(root, configuration);
    if (!fs.statSync(configDir).isDirectory()) continue;
    for (const task of fs.readdirSync(configDir)) {
      const taskDir = path.join(configDir, task);
      if (!fs.statSync(taskDir).isDirectory()) continue;
      for (const file of fs.readdirSync(taskDir).filter((f) => /^run-[0-9]+\.json$/.test(f))) {
        results.push(checkRunResult(JSON.parse(fs.readFileSync(path.join(taskDir, file), 'utf8'))));
      }
    }
  }
  return results;
}

/** Files, added and removed lines of a unified diff (counts only, no path kept). */
export function diffStats(patch: string): { files: number; added: number; removed: number } {
  let files = 0;
  let added = 0;
  let removed = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) files += 1;
    else if (line.startsWith('+') && !line.startsWith('+++')) added += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) removed += 1;
  }
  return { files, added, removed };
}
