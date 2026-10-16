// The report of one evaluation on the server (task L06, design/ADR-M83 §2.2, §2.3). Pure: the
// stored results become run results of `@sdlc/eval`, the report and the recommendations come from
// the same engine as `pnpm eval` (QUESTIONS #480). Numbers and codes only, never a prompt, task
// text or diff; money and token sums stay decimal strings.
import {
  buildReport,
  recommend,
  type ConfigurationSummary,
  type Comparison,
  type Recommendation,
  type RecommendationThresholds,
  type RunResult,
} from '@sdlc/eval';

/** One stored result with the codes of its run (`evaluationRuns.resultsForEvaluation`). */
export interface StoredResult {
  readonly configuration_id: string;
  readonly task_id: string;
  readonly run_index: number;
  readonly model: string;
  readonly agent_version: string;
  readonly instructions_sha256: string;
  readonly outcome: string;
  readonly status: string;
  readonly stop_reason: string | null;
  readonly applied: boolean;
  readonly resolved: boolean;
  readonly fail_to_pass_passed: boolean;
  readonly pass_to_pass_passed: boolean;
  readonly ci_passed: boolean;
  readonly scope_breach: boolean;
  readonly out_of_plan_files: number;
  readonly lint_findings: number;
  readonly diff_files: number;
  readonly diff_lines_added: number;
  readonly diff_lines_removed: number;
  readonly seconds: number;
  readonly iterations: number;
  readonly model_calls: number;
  readonly input_tokens: string | number;
  readonly output_tokens: string | number;
  readonly cached_input_tokens: string | number;
  readonly cost_usd: string;
  readonly hw_cpu_model: string;
  readonly hw_cpu_cores: number;
  readonly hw_memory_gb: number;
  readonly hw_docker_version: string;
  readonly hw_gpu: string | null;
  readonly hw_runner_instance: string | null;
}

/** A stored result as a run result of the engine (the place is always the server). */
export function toRunResult(row: StoredResult, taskSet: number): RunResult {
  return {
    schema: 1,
    task_set: taskSet,
    task: row.task_id,
    configuration: row.configuration_id,
    model: row.model,
    agent_version: row.agent_version,
    instructions_sha256: row.instructions_sha256,
    run: row.run_index,
    outcome: row.outcome,
    status: row.status,
    stop_reason: row.stop_reason,
    applied: row.applied,
    resolved: row.resolved,
    fail_to_pass_passed: row.fail_to_pass_passed,
    pass_to_pass_passed: row.pass_to_pass_passed,
    ci_passed: row.ci_passed,
    scope_breach: row.scope_breach,
    out_of_plan_files: row.out_of_plan_files,
    lint_findings: row.lint_findings,
    diff_files: row.diff_files,
    diff_lines_added: row.diff_lines_added,
    diff_lines_removed: row.diff_lines_removed,
    seconds: row.seconds,
    iterations: row.iterations,
    model_calls: row.model_calls,
    input_tokens: Number(row.input_tokens),
    output_tokens: Number(row.output_tokens),
    cached_input_tokens: Number(row.cached_input_tokens),
    cost_usd: normaliseUsd(row.cost_usd),
    where: 'server',
    hardware: {
      cpu_model: row.hw_cpu_model,
      cpu_cores: row.hw_cpu_cores,
      memory_gb: row.hw_memory_gb,
      docker_version: row.hw_docker_version,
      gpu: row.hw_gpu,
      runner_instance: row.hw_runner_instance,
    },
  };
}

/** `numeric(18,6)` as six decimals (`0.01` → `0.010000`). */
function normaliseUsd(value: string): string {
  const [whole = '0', fraction = ''] = value.split('.');
  return `${whole}.${(fraction + '000000').slice(0, 6)}`;
}

const interval = (i: { estimate: number; low: number; high: number }) => ({
  estimate: round(i.estimate),
  low: round(i.low),
  high: round(i.high),
});
const round = (value: number): number => Number(value.toFixed(3));

function presentConfiguration(c: ConfigurationSummary): Record<string, unknown> {
  return {
    configuration: c.configuration,
    model: c.model,
    tasks: c.tasks,
    runs: c.runs,
    k: c.k,
    resolved: interval(c.resolved),
    pass_at_1: c.passAt1,
    pass_at_k: c.passAtK,
    pass_hat_k: c.passHatK,
    ci_first_try: c.ciFirstTry,
    scope_breaches: c.scopeBreaches,
    stopped: c.stopped,
    stopped_at_cap: c.stoppedAtCap,
    median_seconds: c.medianSeconds,
    total_cost_usd: c.totalCostUsd,
    cost_per_run_usd: c.costPerRunUsd,
    cost_per_resolved_usd: c.costPerResolvedUsd,
  };
}

function presentComparison(c: Comparison): Record<string, unknown> {
  return {
    a: c.a,
    b: c.b,
    pairs: c.pairs,
    paired_tasks: c.pairedTasks,
    only_a: c.onlyA,
    only_b: c.onlyB,
    p_value: c.pValue,
    better: c.better,
  };
}

function presentRecommendation(r: Recommendation): Record<string, unknown> {
  return { rule: r.rule, configuration: r.configuration, other: r.other, numbers: r.numbers };
}

/** The report body: summaries, comparisons and recommendations of the stored results. */
export function buildEvaluationReport(
  rows: readonly StoredResult[],
  taskSet: number,
  thresholds: RecommendationThresholds,
): Record<string, unknown> {
  const thresholdsBody = {
    alpha: thresholds.alpha,
    min_paired_tasks: thresholds.minPairedTasks,
    low_ci_first_try_rate: thresholds.lowCiFirstTryRate,
    unstable_gap: thresholds.unstableGap,
    stopped_at_cap_share: thresholds.stoppedAtCapShare,
  };
  if (rows.length === 0) {
    return {
      results: 0,
      thresholds: thresholdsBody,
      configurations: [],
      comparisons: [],
      recommendations: [],
    };
  }
  const report = buildReport(
    rows.map((row) => toRunResult(row, taskSet)),
    taskSet,
    [],
    1,
    thresholds.alpha,
  );
  return {
    results: rows.length,
    thresholds: thresholdsBody,
    configurations: report.configurations.map(presentConfiguration),
    comparisons: report.comparisons.map(presentComparison),
    recommendations: recommend(report, thresholds).map(presentRecommendation),
  };
}
