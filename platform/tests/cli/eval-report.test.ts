// `sdlc eval report` and `sdlc next` without an intent (task L06, ADR-M83 §2.2, QUESTIONS #482)
// against a mocked API, with the body built by the api's own report code: the summaries, the
// comparison, the recommendations as catalog texts with the agent register note, the real-run
// numbers or the note that they are hidden. Also the api's mapping of stored results.
import { evaluationReportSchema } from '@sdlc/api-schemas';
import { DEFAULT_RECOMMENDATION_THRESHOLDS, renderRecommendation } from '@sdlc/eval';
import { t } from '@sdlc/messages';
import { describe, expect, it } from 'vitest';

import { buildEvaluationReport } from '../../apps/api/src/evaluations/report.js';
import { EXIT } from '../../apps/cli/src/index.js';
import { toRunResult, type StoredResult } from '../../packages/core/src/evaluation/report-rows.js';
import { evaluationBody } from './fixtures.js';
import { useHarness } from './harness.js';

const harness = useHarness();
const TASKS = ['t-a', 't-b', 't-c', 't-d', 't-e', 't-f', 't-g', 't-h'];

function stored(
  configuration: string,
  task: string,
  over: Partial<StoredResult> = {},
): StoredResult {
  return {
    configuration_id: configuration,
    task_id: task,
    run_index: 1,
    model: `${configuration}-model`,
    agent_version: '1.0.0',
    instructions_sha256: 'a'.repeat(64),
    outcome: 'finished',
    status: 'succeeded',
    stop_reason: null,
    applied: true,
    resolved: task < 't-g',
    fail_to_pass_passed: task < 't-g',
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
    input_tokens: '1000',
    output_tokens: '100',
    cached_input_tokens: '0',
    cost_usd: configuration === 'cheap' ? '0.002' : '0.020000',
    hw_cpu_model: 'Apple M4 Pro',
    hw_cpu_cores: 12,
    hw_memory_gb: 24,
    hw_docker_version: '29.8.2',
    hw_gpu: null,
    hw_runner_instance: 'runner-1',
    ...over,
  };
}

const rows = TASKS.flatMap((task) => [stored('cheap', task), stored('dear', task)]);

function reportBody(realRuns: unknown): Record<string, unknown> {
  return {
    evaluation: {
      ...evaluationBody(true),
      status: 'completed',
      finished_at: '2026-10-14T09:00:00.000Z',
    },
    final: true,
    ...buildEvaluationReport(rows, 1, DEFAULT_RECOMMENDATION_THRESHOLDS),
    real_runs: realRuns,
  };
}

describe('the api report of stored results (ADR-M83 §2.2)', () => {
  it('maps a stored row to a server run result with six-decimal money and number tokens', () => {
    const result = toRunResult(stored('cheap', 't-a'), 1);
    expect(result).toMatchObject({
      task_set: 1,
      configuration: 'cheap',
      run: 1,
      cost_usd: '0.002000',
      input_tokens: 1000,
      where: 'server',
      hardware: { cpu_model: 'Apple M4 Pro', runner_instance: 'runner-1' },
    });
  });

  it('an evaluation without results gives an empty report with the thresholds', () => {
    expect(buildEvaluationReport([], 1, DEFAULT_RECOMMENDATION_THRESHOLDS)).toMatchObject({
      results: 0,
      configurations: [],
      recommendations: [],
      thresholds: { alpha: 0.05, min_paired_tasks: 8 },
    });
  });

  it('the body passes the shared response schema', () => {
    expect(evaluationReportSchema.safeParse(reportBody(null)).success).toBe(true);
  });
});

describe('sdlc eval report', () => {
  it('prints the summaries, the comparison and the recommendation with the register note', async () => {
    const h = await harness({
      routes: {
        'GET /v1/evaluations/EVAL-2026-0001/report': {
          status: 200,
          body: reportBody({ available: false, reason: 'no_role' }),
        },
      },
    });
    expect(await h.run(['eval', 'report', 'EVAL-2026-0001'])).toBe(EXIT.ok);
    const out = h.out.join('\n');
    expect(out).toContain(t('cli.eval.report.final', { results: 16 }));
    expect(out).toContain('cheap (cheap-model): 8 tasks, 8 runs; resolved 75%');
    expect(out).toContain(
      t('cli.eval.report.no_difference', { a: 'cheap', b: 'dear', better: '-', tasks: 8, p: 1 }),
    );
    const body = buildEvaluationReport(rows, 1, DEFAULT_RECOMMENDATION_THRESHOLDS) as {
      recommendations: Parameters<typeof renderRecommendation>[0][];
    };
    expect(out).toContain(
      t('cli.eval.report.recommendation', { text: renderRecommendation(body.recommendations[0]!) }),
    );
    expect(out).toContain(t('eval.recommendation.register_note'));
    expect(out).toContain(t('cli.eval.report.real_runs_hidden'));
  });

  it('shows the real-run numbers of the same models when the caller may read them', async () => {
    const realRuns = {
      available: true,
      scope: { kind: 'project', project: 'shop' },
      from: '2026-09-14T08:00:00.000Z',
      to: '2026-10-14T08:00:00.000Z',
      filters: { agent: null, model: null },
      rows: [
        {
          project: 'shop',
          agent: 'openhands-default',
          agent_version: '1.0.0',
          model: 'cheap-model',
          runs: { total: 4, in_progress: 0, by_status: {}, by_stop_reason: {}, retries: 0 },
          ci: { first_try_total: 4, first_try_passed: 3 },
          merged: {
            intents: 2,
            without_changes_requested: 1,
            lead_time: { count: 2, avg_seconds: 100, max_seconds: 120 },
          },
          scope_breaches: 0,
          tokens: { input: '10', output: '5', cached_input: '0', cache_share_percent: 0 },
          cost: {
            total_usd: '0.040000',
            wasted_usd: '0.000000',
            per_run_usd: '0.010000',
            per_merged_intent_usd: '0.020000',
          },
        },
      ],
      unattributed_cost_usd: '0.000000',
      truncated: false,
    };
    const h = await harness({
      routes: {
        'GET /v1/evaluations/EVAL-2026-0001/report': { status: 200, body: reportBody(realRuns) },
      },
    });
    expect(await h.run(['eval', 'report', 'EVAL-2026-0001'])).toBe(EXIT.ok);
    expect(h.out.at(-1)).toBe(
      t('cli.eval.report.real_run', {
        agent: 'openhands-default',
        version: '1.0.0',
        model: 'cheap-model',
        runs: 4,
        ci: '3/4',
        merged: 2,
        without_changes: 1,
        cost_per_run: '0.010000',
      }),
    );
  });

  it('--json prints the body; a bad code prints the usage without calling the API', async () => {
    const h = await harness({
      routes: {
        'GET /v1/evaluations/EVAL-2026-0001/report': { status: 200, body: reportBody(null) },
      },
    });
    expect(await h.run(['eval', 'report', 'EVAL-2026-0001', '--json'])).toBe(EXIT.ok);
    expect(JSON.parse(h.out.join('\n'))).toMatchObject({ final: true, results: 16 });
    expect(await h.run(['eval', 'report', 'INT-2026-0001'])).toBe(EXIT.usage);
    expect(h.requests).toHaveLength(1);
  });
});

describe('sdlc next without an intent (QUESTIONS #482)', () => {
  it('lists the evaluations that ended in the last 7 days with the report command', async () => {
    const ended = {
      ...evaluationBody(),
      status: 'completed',
      finished_at: '2026-10-14T09:00:00.000Z',
      project: 'shop',
    };
    const h = await harness({
      routes: {
        'GET /v1/evaluations/recent': {
          status: 200,
          body: { since: '2026-10-07T08:00:00.000Z', evaluations: [ended] },
        },
      },
    });
    expect(await h.run(['next'])).toBe(EXIT.ok);
    expect(h.out).toEqual([
      t('cli.next.evaluation_ended', {
        code: 'EVAL-2026-0001',
        project: 'shop',
        status: 'completed',
        finished_at: '2026-10-14T09:00:00.000Z',
      }),
    ]);
  });

  it('says so when none ended', async () => {
    const h = await harness({
      routes: {
        'GET /v1/evaluations/recent': {
          status: 200,
          body: { since: '2026-10-07T08:00:00.000Z', evaluations: [] },
        },
      },
    });
    expect(await h.run(['next'])).toBe(EXIT.ok);
    expect(h.out).toEqual([t('cli.next.evaluations_none')]);
  });
});
