// The report of an evaluation in the dashboard (task L06, design/ADR-M83 §2.2, §2.3). Pure: no
// DOM. Numbers become text here; money stays the API's decimal string and never passes a float.
import type { EvaluationReportView } from '@sdlc/api-schemas';

type Interval = EvaluationReportView['configurations'][number]['resolved'];
type Recommendation = EvaluationReportView['recommendations'][number];
type Comparison = EvaluationReportView['comparisons'][number];

/** A share in 0..1 as a whole percent ("43%"). */
export function percent(share: number): string {
  return `${String(Math.round(share * 100))}%`;
}

/** An estimate with its 95% interval ("43% (31%–55%)"). */
export function withInterval(value: Interval): string {
  return `${percent(value.estimate)} (${percent(value.low)}–${percent(value.high)})`;
}

/** A p-value with at most three decimals; below 0.001 as "< 0.001". */
export function pValue(p: number): string {
  return p < 0.001 ? '< 0.001' : String(Math.round(p * 1000) / 1000);
}

/** The catalog keys of the recommendation rules; the same as `@sdlc/eval` (a test checks it). */
export const RULE_KEYS: Readonly<Record<string, string>> = {
  cheaper_model_no_difference: 'eval.recommendation.cheaper_model_no_difference',
  low_ci_first_try: 'eval.recommendation.low_ci_first_try',
  unstable_results: 'eval.recommendation.unstable_results',
  stopped_at_cap: 'eval.recommendation.stopped_at_cap',
  scope_breach: 'eval.recommendation.scope_breach',
};

/** The key and parameters of a recommendation; `undefined` for a rule this version does not know. */
export function recommendationMessage(
  rec: Recommendation,
): { readonly key: string; readonly params: Readonly<Record<string, string>> } | undefined {
  const key = Object.hasOwn(RULE_KEYS, rec.rule) ? RULE_KEYS[rec.rule] : undefined;
  if (key === undefined) return undefined;
  return {
    key,
    params: { configuration: rec.configuration, other: rec.other ?? '', ...rec.numbers },
  };
}

/** The key and parameters of a paired comparison: a difference only when the API found one. */
export function comparisonMessage(c: Comparison): {
  readonly key: string;
  readonly params: Readonly<Record<string, string | number>>;
} {
  return {
    key:
      c.better === null
        ? 'dashboard.eval.report.no_difference'
        : 'dashboard.eval.report.difference',
    params: { a: c.a, b: c.b, better: c.better ?? '', tasks: c.paired_tasks, p: pValue(c.p_value) },
  };
}

export type RealRunsState = 'hidden' | 'none' | 'shown';

/** Whether the real-run numbers (V13) are shown, hidden for lack of a role, or empty. */
export function realRunsState(real: EvaluationReportView['real_runs']): RealRunsState {
  if (real === null || !real.available) return 'hidden';
  return real.rows.length === 0 ? 'none' : 'shown';
}
