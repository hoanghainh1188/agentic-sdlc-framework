// Recommendations by rules (task L06, design/ADR-M83 §2.3, AC2, AC3, AC5; QUESTIONS #481): each
// rule on synthetic results — it fires, it does not fire, a comparing rule stays silent below the
// minimum of paired tasks or when the data shows a difference — and the numbers it quotes. Texts
// come from the catalog and never say "as good as".
import { defaultProjectConfig, loadProjectConfig } from '@sdlc/config';
import { t } from '@sdlc/messages';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RECOMMENDATION_THRESHOLDS,
  buildReport,
  differs,
  recommend,
  renderRecommendation,
  thresholdsFromConfig,
  type Recommendation,
  type RunResult,
} from '../../eval/src/index.js';

const TASKS = ['t-a', 't-b', 't-c', 't-d', 't-e', 't-f', 't-g', 't-h'];

function run(
  configuration: string,
  task: string,
  n: number,
  resolved: boolean,
  over: Partial<RunResult> = {},
): RunResult {
  return {
    schema: 1,
    task_set: 1,
    task,
    configuration,
    model: `${configuration}-model`,
    agent_version: '1.0.0',
    instructions_sha256: 'a'.repeat(64),
    run: n,
    outcome: 'finished',
    status: 'succeeded',
    stop_reason: null,
    applied: true,
    resolved,
    fail_to_pass_passed: resolved,
    pass_to_pass_passed: true,
    ci_passed: true,
    scope_breach: false,
    out_of_plan_files: 0,
    lint_findings: 0,
    diff_files: 1,
    diff_lines_added: 2,
    diff_lines_removed: 1,
    seconds: 60,
    iterations: 5,
    model_calls: 5,
    input_tokens: 1000,
    output_tokens: 100,
    cached_input_tokens: 0,
    cost_usd: '0.010000',
    ...over,
  };
}

/** `runs` runs of each task for a configuration; `resolvedAt(task, n)` decides each outcome. */
function config(
  configuration: string,
  tasks: readonly string[],
  runs: number,
  resolvedAt: (task: string, n: number) => boolean,
  over: (task: string, n: number) => Partial<RunResult> = () => ({}),
): RunResult[] {
  return tasks.flatMap((task) =>
    Array.from({ length: runs }, (_, i) =>
      run(configuration, task, i + 1, resolvedAt(task, i + 1), over(task, i + 1)),
    ),
  );
}

const rules = (list: readonly Recommendation[]) => list.map((r) => r.rule);
const recs = (results: RunResult[], thresholds = DEFAULT_RECOMMENDATION_THRESHOLDS) =>
  recommend(buildReport(results, 1), thresholds);

describe('one test for a difference (ADR-M83 §2.3)', () => {
  const interval = (estimate: number, low: number, high: number) => ({ estimate, low, high });

  it('needs p below alpha and intervals apart', () => {
    expect(differs(interval(0.9, 0.8, 1), interval(0.1, 0, 0.2), 0.01, 0.05)).toBe(true);
    expect(differs(interval(0.9, 0.8, 1), interval(0.1, 0, 0.2), 0.2, 0.05)).toBe(false);
    expect(differs(interval(0.6, 0.3, 0.9), interval(0.4, 0.1, 0.7), 0.001, 0.05)).toBe(false);
  });
});

describe('cheaper_model_no_difference', () => {
  // `cheap` and `dear` both resolve 6 of 8 tasks (the same ones): no difference, `cheap` costs less.
  const same = (task: string) => task < 't-g';
  const cheapAndDear = (tasks = TASKS) => [
    ...config('cheap', tasks, 3, same, () => ({ cost_usd: '0.002000' })),
    ...config('dear', tasks, 3, same, () => ({ cost_usd: '0.020000' })),
  ];

  it('fires with enough paired tasks, quoting both rates, intervals, p and costs', () => {
    const found = recs(cheapAndDear()).filter((r) => r.rule === 'cheaper_model_no_difference');
    expect(found).toHaveLength(1);
    const rec = found[0]!;
    expect(rec.configuration).toBe('cheap');
    expect(rec.other).toBe('dear');
    expect(rec.numbers).toMatchObject({
      paired_tasks: '8',
      resolved: '75%',
      other_resolved: '75%',
      p_value: '1',
      cost_per_run_usd: '0.002000',
      other_cost_per_run_usd: '0.020000',
    });
    expect(rec.numbers['resolved_low']).toMatch(/^\d+%$/);
    expect(rec.numbers['other_resolved_high']).toMatch(/^\d+%$/);
  });

  it('does not fire below the minimum of paired tasks', () => {
    expect(rules(recs(cheapAndDear(TASKS.slice(0, 7))))).not.toContain(
      'cheaper_model_no_difference',
    );
    const lower = { ...DEFAULT_RECOMMENDATION_THRESHOLDS, minPairedTasks: 7 };
    expect(rules(recs(cheapAndDear(TASKS.slice(0, 7)), lower))).toContain(
      'cheaper_model_no_difference',
    );
  });

  it('does not fire when the data shows the dearer one resolves more', () => {
    const results = [
      ...config(
        'cheap',
        TASKS,
        3,
        () => false,
        () => ({ cost_usd: '0.002000' }),
      ),
      ...config(
        'dear',
        TASKS,
        3,
        () => true,
        () => ({ cost_usd: '0.020000' }),
      ),
    ];
    expect(rules(recs(results))).not.toContain('cheaper_model_no_difference');
  });

  it('does not fire when neither resolves anything', () => {
    const results = [
      ...config(
        'cheap',
        TASKS,
        3,
        () => false,
        () => ({ cost_usd: '0.002000' }),
      ),
      ...config(
        'dear',
        TASKS,
        3,
        () => false,
        () => ({ cost_usd: '0.020000' }),
      ),
    ];
    expect(rules(recs(results))).not.toContain('cheaper_model_no_difference');
  });

  it('does not fire when both cost the same', () => {
    const results = [...config('a', TASKS, 3, same), ...config('b', TASKS, 3, same)];
    expect(rules(recs(results))).not.toContain('cheaper_model_no_difference');
  });

  it('says "no difference found on N tasks", never "as good as"', () => {
    const rec = recs(cheapAndDear()).find((r) => r.rule === 'cheaper_model_no_difference')!;
    const text = renderRecommendation(rec);
    expect(text).toContain('8');
    expect(text).toContain('75%');
    expect(text.toLowerCase()).not.toContain('as good as');
    expect(text.toLowerCase()).not.toContain('as well as');
  });
});

describe('low_ci_first_try', () => {
  it('fires below the rate and quotes it', () => {
    const results = config(
      'a',
      TASKS,
      2,
      () => true,
      (task) => ({ ci_passed: task < 't-c' }),
    );
    const rec = recs(results).find((r) => r.rule === 'low_ci_first_try')!;
    expect(rec.configuration).toBe('a');
    expect(rec.numbers).toMatchObject({ ci_first_try: '25%', threshold: '50%' });
  });

  it('does not fire at or above the rate', () => {
    const results = config(
      'a',
      TASKS,
      2,
      () => true,
      (task) => ({ ci_passed: task < 't-e' }),
    );
    expect(rules(recs(results))).not.toContain('low_ci_first_try');
  });
});

describe('unstable_results', () => {
  it('fires when pass@k is far above pass^k', () => {
    // Every task: run 1 resolves, runs 2 and 3 do not → pass@3 = 1, pass^3 = 0.
    const results = config('a', TASKS, 3, (_task, n) => n === 1);
    const rec = recs(results).find((r) => r.rule === 'unstable_results')!;
    expect(rec.numbers).toMatchObject({ k: '3', pass_at_k: '100%', pass_hat_k: '0%' });
  });

  it('does not fire when results repeat', () => {
    const results = config('a', TASKS, 3, (task) => task < 't-e');
    expect(rules(recs(results))).not.toContain('unstable_results');
  });

  it('does not fire with one run per task (k = 1)', () => {
    const results = config('a', TASKS, 1, (task) => task < 't-e');
    expect(rules(recs(results))).not.toContain('unstable_results');
  });
});

describe('stopped_at_cap', () => {
  it('fires when the share of runs stopped at a cap reaches the threshold', () => {
    const results = config(
      'a',
      TASKS,
      5,
      () => false,
      (_task, n) => (n === 1 ? { status: 'stopped_timeout', outcome: 'stopped' } : {}),
    );
    const rec = recs(results).find((r) => r.rule === 'stopped_at_cap')!;
    expect(rec.numbers).toMatchObject({ stopped: '8', runs: '40', share: '20%' });
  });

  it('does not fire below the threshold, and a failed run is not a cap', () => {
    const results = config(
      'a',
      TASKS,
      5,
      () => false,
      (task, n) =>
        n === 1 && task < 't-c'
          ? { status: 'stopped_timeout' }
          : n === 2
            ? { status: 'failed' }
            : {},
    );
    expect(rules(recs(results))).not.toContain('stopped_at_cap');
  });
});

describe('scope_breach', () => {
  it('fires on any breach and quotes the count', () => {
    const results = config(
      'a',
      TASKS,
      2,
      () => true,
      (task, n) => ({
        scope_breach: task === 't-a' && n === 1,
      }),
    );
    const rec = recs(results).find((r) => r.rule === 'scope_breach')!;
    expect(rec.numbers).toMatchObject({ breaches: '1', runs: '16' });
  });

  it('does not fire without a breach', () => {
    expect(rules(recs(config('a', TASKS, 2, () => true)))).not.toContain('scope_breach');
  });
});

describe('texts (AC3, NFR-08)', () => {
  it('every rule has a catalog text with every number filled, plus the register note', () => {
    const results = [
      ...config(
        'cheap',
        TASKS,
        3,
        (_t, n) => n === 1,
        (task, n) => ({
          cost_usd: '0.002000',
          ci_passed: false,
          scope_breach: n === 1 && task === 't-a',
          ...(n === 2 ? { status: 'stopped_iterations' } : {}),
        }),
      ),
      ...config(
        'dear',
        TASKS,
        3,
        (_t, n) => n === 1,
        () => ({ cost_usd: '0.020000' }),
      ),
    ];
    const list = recs(results);
    expect(new Set(rules(list))).toEqual(
      new Set([
        'cheaper_model_no_difference',
        'low_ci_first_try',
        'unstable_results',
        'stopped_at_cap',
        'scope_breach',
      ]),
    );
    for (const rec of list) {
      const text = renderRecommendation(rec);
      expect(text).not.toMatch(/\{[a-z_]+\}/);
      expect(text).toContain(t('eval.recommendation.register_note'));
    }
  });

  it('gives nothing for a single clean configuration', () => {
    expect(recs(config('a', TASKS, 3, () => true))).toEqual([]);
  });
});

describe('thresholds from the project configuration (ADR-M83 §2.3)', () => {
  it('the shipped defaults equal the defaults of the rules', () => {
    expect(thresholdsFromConfig(defaultProjectConfig().evaluation.recommendations)).toEqual(
      DEFAULT_RECOMMENDATION_THRESHOLDS,
    );
  });

  it('refuses a share outside 0..1, an alpha above 0.1 and fewer than 2 paired tasks', () => {
    const bad = (recommendations: Record<string, number>) =>
      loadProjectConfig(
        `evaluation:\n  recommendations:\n${Object.entries(recommendations)
          .map(([key, value]) => `    ${key}: ${String(value)}\n`)
          .join('')}`,
      );
    for (const over of [
      { alpha: 0.2 },
      { min_paired_tasks: 1 },
      { low_ci_first_try_rate: 1 },
      { unstable_gap: 0 },
      { stopped_at_cap_share: -0.1 },
    ]) {
      const result = bad({ ...DEFAULTS, ...over });
      expect(result.ok).toBe(false);
    }
    expect(bad(DEFAULTS).ok).toBe(true);
  });
});

const DEFAULTS = {
  alpha: 0.05,
  min_paired_tasks: 8,
  low_ci_first_try_rate: 0.5,
  unstable_gap: 0.3,
  stopped_at_cap_share: 0.2,
};
