// D-08 L05 (PR 4) on PostgreSQL: the worker's plan loop (design/ADR-M82 §2.4, QUESTIONS #472,
// #476), one step per plan (`advanceEvaluationPlan`) and the loop over tenants:
// - Run now: the request is taken once and the evaluation started as the person who asked; a
//   refusal (a model the gateway no longer lists) stays on the plan and in the audit log;
// - a due schedule starts one run as the system, a missed one once, the next time from now; an
//   open evaluation waits;
// - `on_change`: the first sight is recorded without a run; a change of the models starts one;
// - a pause for the monthly cap ends at the time it was set to;
// - the loop visits only tenants with plan work, and one plan's error never stops the others.
import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';
import type { ModelRef } from '@sdlc/contracts';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { EvaluationPlanLoop } from '../../../apps/worker/src/evaluation-plan-loop.js';
import type { TenantScope as BuiltScope } from '../../../packages/core/dist/index.js';
import {
  advanceEvaluationPlan,
  createEvaluationPlan,
  requestEvaluationPlanRun,
  type PlanContentInput,
} from '../../../packages/core/src/evaluation/index.js';
import { EVAL_BASE_SHA } from '../evaluation-seed.js';
import { seedPlanWorld, type PlanWorld } from '../plan-seed.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

const T0 = new Date('2026-10-14T08:00:00.000Z');

describeDb('L05 PR 4: the evaluation plan loop on PostgreSQL', () => {
  let t: TestDatabase;
  let tenants = 0;
  let now = T0;
  let models: ModelRef[];
  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  });

  const deps = () => ({
    policyFactory: (
      config: Parameters<typeof createSimplePolicyEngine>[0]['config'],
      list: readonly ModelRef[],
    ) => createSimplePolicyEngine({ config, models: list }),
    models: () => Promise.resolve(models),
    taskSet: (version: number) =>
      Promise.resolve(
        version === 1 ? { version: 1, baseSha: EVAL_BASE_SHA, taskIds: ['feat-tax'] } : undefined,
      ),
    gitHost: {
      getBranchHead: () => Promise.resolve('c'.repeat(40)),
      getFileAtCommit: () => Promise.resolve('prompt\n'),
    },
    now: () => now,
  });

  async function world(): Promise<PlanWorld> {
    now = T0;
    models = [
      { model: 'gpt-oss-20b', providerType: 'self_hosted' },
      { model: 'qwen3-8b', providerType: 'self_hosted' },
    ];
    return seedPlanWorld(t.app, `loop-plans-${String(++tenants)}`, T0);
  }

  const content = (over: Partial<PlanContentInput> = {}): PlanContentInput => ({
    dataClass: 'internal',
    taskSetVersion: 1,
    taskIds: null,
    runsPerTask: 1,
    budgetPerRunUsd: '1',
    monthlyCapUsd: '10',
    trigger: 'once',
    configurations: [
      { id: 'reg-qwen', agentKey: 'openhands-qwen', maxIterations: 30, maxDurationMin: 20 },
    ],
    ...over,
  });

  // The api saves without the gateway (QUESTIONS #476): no models, no task sets.
  const save = (w: PlanWorld, over: Partial<PlanContentInput> = {}, code = 'p') =>
    createEvaluationPlan(
      w.scope,
      {
        policyFactory: deps().policyFactory,
        gitHost: deps().gitHost,
        now: () => now,
      },
      { projectId: w.projectId, code, content: content(over), userId: w.users.a },
    );
  const step = (w: PlanWorld, planId: string) => advanceEvaluationPlan(w.scope, deps(), planId);
  const plan = (w: PlanWorld, id: string) => w.scope.evaluationPlans.getById(id);
  const audit = async (w: PlanWorld, id: string) =>
    (await w.scope.audit.listForEntity(id)).map((e) => e.action);

  it('Run now: started once as the person who asked', async () => {
    const w = await world();
    const p = await save(w);
    expect(await step(w, p.id)).toEqual({ outcome: 'idle' });
    await requestEvaluationPlanRun(w.scope, { planId: p.id, userId: w.users.a });
    const started = await step(w, p.id);
    expect(started).toMatchObject({ outcome: 'started', reason: 'manual' });
    if (started.outcome !== 'started') return;
    const evaluation = await w.scope.evaluations.getById(started.evaluationId);
    expect(evaluation).toMatchObject({ plan_id: p.id, started_by: w.users.a });
    expect(await plan(w, p.id)).toMatchObject({ run_requested_at: null, last_refusal: null });
    expect(await step(w, p.id)).toEqual({ outcome: 'idle' });
  });

  it('Run now refused: the code stays on the plan and in the audit log', async () => {
    const w = await world();
    const p = await save(w);
    models = []; // the gateway no longer lists the agent's model
    await requestEvaluationPlanRun(w.scope, { planId: p.id, userId: w.users.a });
    expect(await step(w, p.id)).toEqual({
      outcome: 'refused',
      code: 'model_not_allowed',
      reason: 'manual',
    });
    expect(await plan(w, p.id)).toMatchObject({
      run_requested_at: null,
      last_refusal: 'model_not_allowed',
    });
    expect(await audit(w, p.id)).toContain('evaluation_plan.run_refused');
    // A new request clears the old refusal.
    models = [{ model: 'qwen3-8b', providerType: 'self_hosted' }];
    await requestEvaluationPlanRun(w.scope, { planId: p.id, userId: w.users.a });
    expect((await plan(w, p.id))?.last_refusal).toBeNull();
  });

  it('a schedule: due runs once, missed runs once, the next time from now; an open one waits', async () => {
    const w = await world();
    const p = await save(w, {
      trigger: 'schedule',
      schedule: { every: 'daily', hour: 9, weekday: null },
    });
    expect(p.next_run_at).toEqual(new Date('2026-10-14T09:00:00.000Z'));
    expect(await step(w, p.id)).toEqual({ outcome: 'idle' });
    // Three days later: missed three times, runs once.
    now = new Date('2026-10-17T10:00:00.000Z');
    expect(await step(w, p.id)).toMatchObject({ outcome: 'started', reason: 'schedule' });
    expect((await plan(w, p.id))?.next_run_at).toEqual(new Date('2026-10-18T09:00:00.000Z'));
    // The next day the first evaluation is still open: the run waits for the next time.
    now = new Date('2026-10-18T09:30:00.000Z');
    expect(await step(w, p.id)).toMatchObject({ outcome: 'refused', code: 'evaluation_open' });
    expect(await plan(w, p.id)).toMatchObject({
      next_run_at: new Date('2026-10-19T09:00:00.000Z'),
      last_refusal: null,
    });
  });

  it('on_change: the first sight without a run, a new model on the gateway starts one', async () => {
    const w = await world();
    const p = await save(w, { trigger: 'on_change' });
    expect(p.seen_sha256).toBeNull();
    expect(await step(w, p.id)).toEqual({ outcome: 'seen' });
    expect(await step(w, p.id)).toEqual({ outcome: 'idle' });
    // A new model on the gateway (an agent's new version changes the hash the same way).
    models = [...models, { model: 'qwen3-30b', providerType: 'self_hosted' }];
    expect(await step(w, p.id)).toMatchObject({ outcome: 'started', reason: 'on_change' });
    expect(await step(w, p.id)).toEqual({ outcome: 'idle' });
  });

  it('a pause for the monthly cap ends when its time came', async () => {
    const w = await world();
    const p = await save(w);
    await w.scope.evaluationPlans.pause(p.id, 'monthly_cap_used', new Date('2026-11-01T00:00:00Z'));
    expect(await step(w, p.id)).toEqual({ outcome: 'idle' });
    now = new Date('2026-11-01T00:00:01Z');
    expect(await step(w, p.id)).toEqual({ outcome: 'resumed' });
    expect((await plan(w, p.id))?.status).toBe('active');
  });

  it('the loop visits tenants with plan work; one failing plan does not stop the others', async () => {
    const w = await world();
    const p1 = await save(w, {}, 'one');
    const p2 = await save(w, {}, 'two');
    await requestEvaluationPlanRun(w.scope, { planId: p1.id, userId: w.users.a });
    await requestEvaluationPlanRun(w.scope, { planId: p2.id, userId: w.users.a });
    expect(await t.app.system.listTenantsWithPlanWork(now, 1000)).toContain(w.scope.tenantId);
    const logs: string[] = [];
    const loop = new EvaluationPlanLoop({
      // Only this test's tenant: other tests leave plans in the same database.
      listTenants: () => Promise.resolve([w.scope.tenantId] as unknown as never[]),
      forTenant: () => w.scope as unknown as BuiltScope,
      advance: (_scope, planId) =>
        planId === p1.id
          ? Promise.reject(new Error('boom'))
          : advanceEvaluationPlan(w.scope, deps(), planId),
      now: () => now,
      logger: { log: (_l: string, event: string) => void logs.push(event) },
    });
    expect(await loop.pass()).toEqual({ started: 1, refused: 0, failed: 1 });
    expect(logs).toContain('worker.evaluation_plan_failed');
    expect(logs).toContain('worker.evaluation_plan_started');
    // The failed plan's request still waits for the next pass.
    expect((await plan(w, p1.id))?.run_requested_at).not.toBeNull();
  });
});
