// Recommendations by rules (task L06, design/ADR-M83 §2.3, §2.4; QUESTIONS #481). Fixed rules
// on a built report, never a model. Each recommendation quotes the numbers and intervals it rests
// on, as strings ready for the catalog text, and never claims what the data does not show:
// - a comparing rule fires only with enough paired tasks, and calls a difference only by `differs`;
// - "no difference found on N tasks" is never "as good as".
// A recommendation is a proposal only: a change of model or prompt still goes through the agent
// register (a new version, approvals, 2+N; ADR-M31). The platform never applies one.
import { t, type MessageKey } from '@sdlc/messages';

import { differs, type ConfigurationSummary, type EvalReport } from './report.js';
import type { Interval } from './stats.js';

export type RecommendationRule =
  | 'cheaper_model_no_difference'
  | 'low_ci_first_try'
  | 'unstable_results'
  | 'stopped_at_cap'
  | 'scope_breach';

/** The thresholds of the rules; on the server they come from the project configuration. */
export interface RecommendationThresholds {
  /** Significance level of a difference (McNemar). */
  readonly alpha: number;
  /** A comparing rule fires only with at least this many paired tasks. */
  readonly minPairedTasks: number;
  /** `low_ci_first_try` fires below this share of runs whose CI passed on the first try. */
  readonly lowCiFirstTryRate: number;
  /** `unstable_results` fires when pass@k minus pass^k is at least this. */
  readonly unstableGap: number;
  /** `stopped_at_cap` fires when this share of runs (or more) stopped at a cap. */
  readonly stoppedAtCapShare: number;
}

/** Defaults of ADR-M83 §2.3 (the shipped project configuration holds the same values). */
export const DEFAULT_RECOMMENDATION_THRESHOLDS: RecommendationThresholds = Object.freeze({
  alpha: 0.05,
  minPairedTasks: 8,
  lowCiFirstTryRate: 0.5,
  unstableGap: 0.3,
  stoppedAtCapShare: 0.2,
});

/** The shape of a project configuration's `evaluation.recommendations` (`@sdlc/contracts`). */
export interface RecommendationSettings {
  readonly alpha: number;
  readonly min_paired_tasks: number;
  readonly low_ci_first_try_rate: number;
  readonly unstable_gap: number;
  readonly stopped_at_cap_share: number;
}

/** The thresholds from a project configuration's `evaluation.recommendations`. */
export function thresholdsFromConfig(c: RecommendationSettings): RecommendationThresholds {
  return {
    alpha: c.alpha,
    minPairedTasks: c.min_paired_tasks,
    lowCiFirstTryRate: c.low_ci_first_try_rate,
    unstableGap: c.unstable_gap,
    stoppedAtCapShare: c.stopped_at_cap_share,
  };
}

export interface Recommendation {
  readonly rule: RecommendationRule;
  readonly configuration: string;
  /** The configuration it was compared with, for comparing rules. */
  readonly other: string | null;
  /** The numbers the text quotes, already formatted (percent, decimal strings, counts). */
  readonly numbers: Readonly<Record<string, string>>;
}

const percent = (value: number): string => `${Math.round(value * 100)}%`;

function micros(usd: string): bigint {
  const [whole = '0', fraction = ''] = usd.split('.');
  return BigInt(whole) * 1_000_000n + BigInt((fraction + '000000').slice(0, 6));
}

function rate(prefix: string, interval: Interval): Record<string, string> {
  return {
    [prefix + 'resolved']: percent(interval.estimate),
    [prefix + 'resolved_low']: percent(interval.low),
    [prefix + 'resolved_high']: percent(interval.high),
  };
}

function cheaperNoDifference(
  report: EvalReport,
  thresholds: RecommendationThresholds,
): Recommendation[] {
  const byId = new Map(report.configurations.map((c) => [c.configuration, c]));
  const out: Recommendation[] = [];
  for (const comparison of report.comparisons) {
    const a = byId.get(comparison.a)!;
    const b = byId.get(comparison.b)!;
    const costA = micros(a.costPerRunUsd);
    const costB = micros(b.costPerRunUsd);
    if (costA === costB) continue;
    const [cheap, dear] = costA < costB ? [a, b] : [b, a];
    if (comparison.pairedTasks < thresholds.minPairedTasks) continue;
    if (dear.resolved.estimate === 0) continue;
    // The rule uses its own alpha, through the one test for a difference.
    const pValue = comparison.pValue;
    if (differs(cheap.resolved, dear.resolved, pValue, thresholds.alpha)) continue;
    out.push({
      rule: 'cheaper_model_no_difference',
      configuration: cheap.configuration,
      other: dear.configuration,
      numbers: {
        model: cheap.model,
        other_model: dear.model,
        paired_tasks: String(comparison.pairedTasks),
        ...rate('', cheap.resolved),
        ...rate('other_', dear.resolved),
        p_value: String(pValue),
        cost_per_run_usd: cheap.costPerRunUsd,
        other_cost_per_run_usd: dear.costPerRunUsd,
      },
    });
  }
  return out;
}

function perConfiguration(
  c: ConfigurationSummary,
  thresholds: RecommendationThresholds,
): Recommendation[] {
  const out: Recommendation[] = [];
  const base = { configuration: c.configuration, other: null };
  if (c.ciFirstTry < thresholds.lowCiFirstTryRate) {
    out.push({
      ...base,
      rule: 'low_ci_first_try',
      numbers: {
        model: c.model,
        ci_first_try: percent(c.ciFirstTry),
        threshold: percent(thresholds.lowCiFirstTryRate),
        runs: String(c.runs),
      },
    });
  }
  if (c.k >= 2 && c.passAtK - c.passHatK >= thresholds.unstableGap) {
    out.push({
      ...base,
      rule: 'unstable_results',
      numbers: {
        model: c.model,
        k: String(c.k),
        pass_at_k: percent(c.passAtK),
        pass_hat_k: percent(c.passHatK),
      },
    });
  }
  if (c.runs > 0 && c.stoppedAtCap / c.runs >= thresholds.stoppedAtCapShare) {
    out.push({
      ...base,
      rule: 'stopped_at_cap',
      numbers: {
        model: c.model,
        stopped: String(c.stoppedAtCap),
        runs: String(c.runs),
        share: percent(c.stoppedAtCap / c.runs),
      },
    });
  }
  if (c.scopeBreaches > 0) {
    out.push({
      ...base,
      rule: 'scope_breach',
      numbers: { model: c.model, breaches: String(c.scopeBreaches), runs: String(c.runs) },
    });
  }
  return out;
}

/** The recommendations of a report, comparing rules first, then per configuration. */
export function recommend(
  report: EvalReport,
  thresholds: RecommendationThresholds = DEFAULT_RECOMMENDATION_THRESHOLDS,
): Recommendation[] {
  return [
    ...cheaperNoDifference(report, thresholds),
    ...report.configurations.flatMap((c) => perConfiguration(c, thresholds)),
  ];
}

const RULE_KEYS: Readonly<Record<RecommendationRule, MessageKey>> = {
  cheaper_model_no_difference: 'eval.recommendation.cheaper_model_no_difference',
  low_ci_first_try: 'eval.recommendation.low_ci_first_try',
  unstable_results: 'eval.recommendation.unstable_results',
  stopped_at_cap: 'eval.recommendation.stopped_at_cap',
  scope_breach: 'eval.recommendation.scope_breach',
};

/** The recommendation as text from the catalog, with the agent register note (AC3). */
export function renderRecommendation(rec: Recommendation, locale?: string): string {
  const params = { configuration: rec.configuration, other: rec.other ?? '', ...rec.numbers };
  return `${t(RULE_KEYS[rec.rule], params, locale)} ${t('eval.recommendation.register_note', {}, locale)}`;
}
