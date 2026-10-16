// D-08 L06 (PR 2) on PostgreSQL through the API (design/ADR-M83 §2.2, §2.3; QUESTIONS #481, #482):
// - `GET /v1/evaluations/:code/report`: the summaries, comparisons and recommendations of the
//   stored results with the project's thresholds; anybody with a role on the project reads it, no
//   role → 404, another tenant → 404; the V13 numbers of real runs only with a role in both read
//   lists (`no_role` for a viewer);
// - `GET /v1/evaluations/recent`: evaluations that ended in the last 7 days, for people with a role
//   in `access.eval_roles` only;
// - the bodies hold codes, numbers, amounts and hashes only.
import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { createApp, type ApiDeps } from '../../../apps/api/src/app.js';
import { issueApiToken } from '../../../packages/core/src/admin/tokens.js';
import type { NewEvaluationRunResult } from '../../../packages/core/src/db/repositories/evaluation-runs.js';
import type { Evaluation } from '../../../packages/core/src/db/schema.js';
import {
  startEvaluation,
  type EvaluationPolicyFactory,
} from '../../../packages/core/src/evaluation/index.js';
import { seedPlanWorld, type PlanWorld } from '../plan-seed.js';
import { tokenIssuedAt } from '../token-clock.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

const NOW = new Date('2026-10-14T08:00:00.000Z');
const TASKS = ['t-a', 't-b', 't-c', 't-d', 't-e', 't-f', 't-g', 't-h'];
const RESULT: NewEvaluationRunResult = {
  instructions_sha256: 'a'.repeat(64),
  outcome: 'finished',
  status: 'succeeded',
  stop_reason: null,
  applied: true,
  resolved: true,
  fail_to_pass_passed: true,
  pass_to_pass_passed: true,
  ci_passed: true,
  scope_breach: false,
  out_of_plan_files: 0,
  lint_findings: 0,
  diff_files: 2,
  diff_lines_added: 20,
  diff_lines_removed: 3,
  seconds: 90,
  iterations: 7,
  model_calls: 7,
  input_tokens: 1000,
  output_tokens: 200,
  cached_input_tokens: 0,
  cost_usd: '0.010000',
  hardware: {
    cpu_model: 'Apple M4 Pro',
    cpu_cores: 12,
    memory_gb: 24,
    docker_version: '29.8.2',
    gpu: null,
    runner_instance: 'runner-1',
  },
};
const configuration = (id: string, model: string) =>
  ({
    id,
    model,
    providerType: 'self_hosted',
    agentVersion: '1.0.0',
    maxIterations: 30,
    maxDurationMin: 20,
  }) as const;

const policyFactory: EvaluationPolicyFactory = (config, models) =>
  createSimplePolicyEngine({ config, models });

describeDb('L06 PR 2: the evaluation report through the API', () => {
  let db: TestDatabase;
  let app: Awaited<ReturnType<typeof createApp>>;
  let w: PlanWorld;
  let other: PlanWorld;
  let evaluation: Evaluation;
  const tokens: Record<string, string> = {};

  beforeAll(async () => {
    db = await createTestDatabase();
    w = await seedPlanWorld(db.app, 'report-api', NOW);
    other = await seedPlanWorld(db.app, 'report-api-other', NOW);
    for (const [key, id] of Object.entries(w.users)) {
      tokens[key] = (
        await issueApiToken(w.scope, { userId: id, name: key, now: tokenIssuedAt() })
      ).token;
    }
    tokens.other = (
      await issueApiToken(other.scope, { userId: other.users.a, name: 'o', now: tokenIssuedAt() })
    ).token;

    // Two configurations on 8 tasks, one run each: both resolve the same 6 tasks; `cheap` costs
    // less and breaches its scope once.
    evaluation = await startEvaluation(
      w.scope,
      {
        projectId: w.projectId,
        dataClass: 'internal',
        taskSetVersion: 1,
        configName: 'local',
        baseSha: '7'.repeat(40),
        taskIds: TASKS,
        configurations: [configuration('cheap', 'qwen3-8b'), configuration('dear', 'gpt-oss-20b')],
        runsPerTask: 1,
        budgetUsd: '5',
        startedBy: null,
        now: NOW,
      },
      { policyFactory },
    );
    for (;;) {
      const claimed = await w.scope.evaluationRuns.claimQueued(20, 'runner-1');
      if (claimed.length === 0) break;
      for (const run of claimed) {
        const resolved = run.task_id < 't-g';
        await w.scope.evaluationRuns.recordResult(run.id, {
          ...RESULT,
          resolved,
          fail_to_pass_passed: resolved,
          scope_breach: run.configuration_id === 'cheap' && run.task_id === 't-a',
          cost_usd: run.configuration_id === 'cheap' ? '0.002000' : '0.020000',
        });
      }
    }
    await w.scope.evaluations.finish(evaluation.id, 'completed', null);

    app = await createApp({
      db: db.app as unknown as ApiDeps['db'],
      settings: { rateLimitPerMinute: 1000, authFailuresPerMinute: 1000 },
      now: () => NOW,
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  const get = async (url: string, who: string) => {
    const reply = await app
      .getHttpAdapter()
      .getInstance()
      .inject({ method: 'GET', url, headers: { authorization: `Bearer ${tokens[who]!}` } });
    return {
      status: reply.statusCode,
      body: reply.json<Record<string, unknown>>(),
      raw: reply.body,
    };
  };

  it('Person A reads the report: summaries, comparison, recommendations, thresholds', async () => {
    const reply = await get(`/v1/evaluations/${evaluation.code}/report`, 'a');
    expect(reply.status).toBe(200);
    const body = reply.body as {
      final: boolean;
      results: number;
      thresholds: Record<string, number>;
      configurations: { configuration: string; resolved: { estimate: number } }[];
      comparisons: { a: string; b: string; paired_tasks: number; better: string | null }[];
      recommendations: { rule: string; configuration: string; numbers: Record<string, string> }[];
      real_runs: { available: boolean };
    };
    expect(body.final).toBe(true);
    expect(body.results).toBe(16);
    expect(body.thresholds).toEqual({
      alpha: 0.05,
      min_paired_tasks: 8,
      low_ci_first_try_rate: 0.5,
      unstable_gap: 0.3,
      stopped_at_cap_share: 0.2,
    });
    expect(body.configurations.map((c) => c.configuration)).toEqual(['cheap', 'dear']);
    expect(body.configurations[0]!.resolved.estimate).toBe(0.75);
    expect(body.comparisons).toEqual([
      expect.objectContaining({ a: 'cheap', b: 'dear', paired_tasks: 8, better: null }),
    ]);
    expect(body.recommendations.map((r) => [r.rule, r.configuration])).toEqual([
      ['cheaper_model_no_difference', 'cheap'],
      ['scope_breach', 'cheap'],
    ]);
    expect(body.recommendations[0]!.numbers).toMatchObject({
      paired_tasks: '8',
      cost_per_run_usd: '0.002000',
      other_cost_per_run_usd: '0.020000',
    });
    expect(body.real_runs).toMatchObject({ available: true, rows: [] });
    // Codes and numbers only: no free text, no hardware label beyond its codes.
    expect(reply.raw).not.toMatch(/canary|prompt text|diff --git/);
  });

  it('a viewer reads the report without the real-run numbers; no role or another tenant → 404', async () => {
    const viewer = await get(`/v1/evaluations/${evaluation.code}/report`, 'viewer');
    expect(viewer.status).toBe(200);
    expect(viewer.body.real_runs).toEqual({ available: false, reason: 'no_role' });
    expect((await get(`/v1/evaluations/${evaluation.code}/report`, 'outsider')).status).toBe(404);
    expect((await get(`/v1/evaluations/${evaluation.code}/report`, 'other')).status).toBe(404);
    expect((await get('/v1/evaluations/EVAL-2026-9999/report', 'a')).status).toBe(404);
  });

  it('recent: Person A sees the ended evaluation; a viewer and another tenant see none', async () => {
    const mine = await get('/v1/evaluations/recent', 'a');
    expect(mine.status).toBe(200);
    expect(mine.body.since).toBe('2026-10-07T08:00:00.000Z');
    expect(mine.body.evaluations).toEqual([
      expect.objectContaining({ code: evaluation.code, status: 'completed', project: 'shop' }),
    ]);
    expect((await get('/v1/evaluations/recent', 'viewer')).body.evaluations).toEqual([]);
    expect((await get('/v1/evaluations/recent', 'other')).body.evaluations).toEqual([]);
  });
});
