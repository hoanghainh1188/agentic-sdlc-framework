// The report of one evaluation on the server (task L06, design/ADR-M83 §2.2, §2.3). Pure: the
// stored results become run results of `@sdlc/eval`, the report and the recommendations come from
// the same engine as `pnpm eval` (QUESTIONS #480). Numbers and codes only, never a prompt, task
// text or diff; money and token sums stay decimal strings.
import { toRunResult, type StoredResult } from '@sdlc/core';
import {
  buildReport,
  recommend,
  type ConfigurationSummary,
  type Comparison,
  type Recommendation,
  type RecommendationThresholds,
} from '@sdlc/eval';

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
