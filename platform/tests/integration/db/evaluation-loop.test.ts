// D-08 L04 (PR 4d) on PostgreSQL: the worker's side of a server evaluation (design/ADR-M81 §2.8).
// - `prepareEvaluationRun`: contract, capped key and two wrapping tokens; a model the gateway no
//   longer lists cancels the run; a used-up budget stops the evaluation;
// - `finishEvaluationRun`: the result with the model calls and the cost from the cost records, a
//   failed, lost, refused or cancelled run, idempotent, and the end of the evaluation;
// - `EvaluationLoop`: hands over runs up to the limit, gives a run without a workflow its next
//   attempt, cancels the workflow of a run of an ended evaluation, cancels a run it cannot prepare.
import crypto from 'node:crypto';

import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';
import type {
  EvaluationRunDispatcher,
  EvaluationRunWorkflowInput,
  EvaluationScoredMeasures,
  ModelRef,
  RunContractSigner,
} from '@sdlc/contracts';
import { Redacted } from '@sdlc/secrets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EvaluationLoop, MAX_PREPARE_FAILURES } from '../../../apps/worker/src/evaluation-loop.js';
import type { TenantScope } from '../../../packages/core/dist/index.js';
import {
  finishEvaluationRun,
  MAX_EVALUATION_ATTEMPTS,
  prepareEvaluationRun,
  type PrepareEvaluationDeps,
} from '../../../packages/core/src/evaluation/index.js';
import { seedEvaluation, type SeededEvaluation } from '../evaluation-seed.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

const NOW = new Date('2026-10-14T08:00:00.000Z');
const MODELS: readonly ModelRef[] = [{ model: 'gpt-oss-20b', providerType: 'self_hosted' }];
const HARDWARE = {
  cpu_model: 'Test CPU',
  cpu_cores: 4,
  memory_gb: 16,
  docker_version: '27.0.1',
  gpu: null,
  runner_instance: 'sdlc',
};
const MEASURES: EvaluationScoredMeasures = {
  agentOutcome: 'finished',
  status: 'succeeded',
  stopReason: null,
  seconds: 42,
  iterations: 5,
  outOfPlanFiles: 0,
  diffFiles: 1,
  diffLinesAdded: 3,
  diffLinesRemoved: 1,
  applied: true,
  ci: true,
  passToPass: true,
  failToPass: true,
  lintFindings: 0,
  instructionsSha256: 'a'.repeat(64),
  hardware: HARDWARE,
};

class FakeSigner implements RunContractSigner {
  sign() {
    return Promise.resolve({
      signature: `vault:v1:${crypto.randomBytes(48).toString('base64')}`,
      keyVersion: 1,
    });
  }
  publicKey() {
    return Promise.reject(new Error('not used'));
  }
}

class FakeDispatcher implements EvaluationRunDispatcher {
  readonly started: EvaluationRunWorkflowInput[] = [];
  readonly cancelled: string[] = [];
  readonly live = new Set<string>();
  failStart = false;
  start(input: EvaluationRunWorkflowInput) {
    if (this.failStart) return Promise.reject(new Error('down'));
    this.started.push(input);
    this.live.add(`${input.evaluationRunId}/${String(input.attempt)}`);
    return Promise.resolve();
  }
  isRunning(ref: { evaluationRunId: string; attempt: number }) {
    return Promise.resolve(this.live.has(`${ref.evaluationRunId}/${String(ref.attempt)}`));
  }
  cancel(ref: { evaluationRunId: string }) {
    this.cancelled.push(ref.evaluationRunId);
    return Promise.resolve();
  }
}

describeDb('L04 PR 4d: the worker side of server evaluations on PostgreSQL', () => {
  let t: TestDatabase;
  let tenants = 0;
  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  });

  const world = (
    options: Parameters<typeof seedEvaluation>[1] extends infer O ? Partial<O> : never,
  ) => seedEvaluation(t.app, { slug: `loop-${String(++tenants)}`, ...options });

  /** Fakes for the Cost Controller; `spend` writes the cost records a sync would copy. */
  function fakes() {
    const calls = { keys: 0, ended: [] as string[], synced: 0 };
    let spend: (() => Promise<void>) | undefined;
    let wraps = 0;
    const costController = {
      issueEvaluationRunKey: () => {
        calls.keys += 1;
        return Promise.resolve({
          key: { key: new Redacted('sk-canary-key-0000000000'), keyId: 'key-1' },
          labels: {},
          maxBudgetUsd: '1',
          limitedBy: 'run' as const,
        });
      },
      endRunKey: async (input: { runId: string }) => {
        calls.ended.push(input.runId);
        await spend?.();
        return { seen: 0, inserted: 0, duplicates: 0, skipped: {} };
      },
      syncSpend: async () => {
        calls.synced += 1;
        await spend?.();
        return { seen: 0, inserted: 0, duplicates: 0, skipped: {} };
      },
    };
    const deps: PrepareEvaluationDeps = {
      signer: new FakeSigner(),
      costController: costController as unknown as PrepareEvaluationDeps['costController'],
      gitHost: {
        issueShortLivedToken: () =>
          Promise.resolve({ token: new Redacted('ghs_canary'), expiresAt: NOW }),
      } as unknown as PrepareEvaluationDeps['gitHost'],
      wrapper: {
        wrap: () => Promise.resolve(new Redacted(`wrap-${String(++wraps)}`)),
      },
      models: () => Promise.resolve(MODELS),
      policyFactory: (config, models) => createSimplePolicyEngine({ config, models }),
      egressAllowlist: ['litellm:4000', 'npm-proxy:4873'],
      now: () => NOW,
    };
    return {
      calls,
      deps,
      setSpend: (fn: () => Promise<void>) => (spend = fn),
      costController,
    };
  }

  async function addCost(w: SeededEvaluation, runId: string, n: number, usd: string) {
    await w.scope.costRecords.insertIfNew({
      projectId: w.projectId,
      intentId: null,
      runId: null,
      gate: null,
      agent: null,
      model: 'gpt-oss-20b',
      providerType: 'self_hosted',
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 10,
      costUsd: usd,
      sourceRef: `loop-call-${runId}-${String(n)}`,
      occurredAt: NOW,
      evaluationRunId: runId,
    });
  }

  describe('prepareEvaluationRun', () => {
    it('signs the contract, issues the capped key and wraps both secrets', async () => {
      const w = await world({});
      const f = fakes();
      const result = await prepareEvaluationRun(w.scope, f.deps, w.runs[0]!);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.run).toMatchObject({
        tenantId: w.scope.tenantId,
        evaluationRunId: w.runs[0],
        attempt: 1,
        keyIssuedAt: NOW,
      });
      expect(result.run.wrappedGitToken).toMatch(/^wrap-/);
      expect(result.run.wrappedVirtualKey).toMatch(/^wrap-/);
      expect(JSON.stringify(result)).not.toContain('canary');
      expect(f.calls.keys).toBe(1);
      expect(await w.scope.evaluationContracts.getForAttempt(w.runs[0]!, 1)).toBeDefined();
      expect((await w.scope.evaluationRuns.getById(w.runs[0]!))?.status).toBe('queued');
    });

    it('cancels a run whose model the gateway no longer lists', async () => {
      const w = await world({});
      const f = fakes();
      const result = await prepareEvaluationRun(
        w.scope,
        { ...f.deps, models: () => Promise.resolve([]) },
        w.runs[0]!,
      );
      expect(result).toEqual({ ok: false, reason: 'model_not_allowed' });
      const run = await w.scope.evaluationRuns.getById(w.runs[0]!);
      expect(run).toMatchObject({ status: 'cancelled', stop_reason: 'model_not_allowed' });
      expect(f.calls.keys).toBe(0);
    });

    it('stops the evaluation when its budget is used up', async () => {
      const w = await world({ budget: '0.5' });
      await addCost(w, w.runs[0]!, 1, '0.5');
      const f = fakes();
      const result = await prepareEvaluationRun(w.scope, f.deps, w.runs[1]!);
      expect(result).toEqual({ ok: false, reason: 'budget_used' });
      expect((await w.scope.evaluations.getById(w.evaluationId))?.status).toBe('stopped_budget');
      expect((await w.scope.evaluationRuns.getById(w.runs[1]!))?.status).toBe('cancelled');
      expect(f.calls.keys).toBe(0);
    });

    it('leaves a run that is not queued alone', async () => {
      const w = await world({});
      const f = fakes();
      expect(await w.scope.evaluationRuns.claim(w.runs[0]!, 1, 'sdlc')).toBe(true);
      expect(await prepareEvaluationRun(w.scope, f.deps, w.runs[0]!)).toEqual({
        ok: false,
        reason: 'not_startable',
      });
    });
  });

  describe('finishEvaluationRun', () => {
    const claim = async (w: SeededEvaluation, index: number) =>
      expect(await w.scope.evaluationRuns.claim(w.runs[index]!, 1, 'sdlc')).toBe(true);
    const finish = (w: SeededEvaluation, f: ReturnType<typeof fakes>, index: number, end: never) =>
      finishEvaluationRun(
        w.scope,
        { costController: f.costController, now: () => NOW, sleep: () => Promise.resolve() },
        { evaluationRunId: w.runs[index]!, attempt: 1, keyIssuedAt: NOW, end },
      );

    it('writes the result with the calls and the cost, and ends the evaluation', async () => {
      const w = await world({});
      const f = fakes();
      f.setSpend(async () => {
        await addCost(w, w.runs[0]!, 1, '0.01');
        await addCost(w, w.runs[0]!, 2, '0.02');
      });
      await claim(w, 0);
      await finish(w, f, 0, { outcome: 'scored', measures: MEASURES } as never);
      const [row] = (await w.scope.evaluationRuns.resultsForEvaluation(w.evaluationId)).filter(
        (r) => r.evaluation_run_id === w.runs[0],
      );
      expect(row).toMatchObject({
        model_calls: 2,
        input_tokens: '200',
        cost_usd: '0.030000',
        resolved: true,
        outcome: 'finished',
      });
      expect(f.calls.ended).toEqual([w.runs[0]]);
      expect((await w.scope.evaluations.getById(w.evaluationId))?.status).toBe('running');
      f.setSpend(() => Promise.resolve());
      await claim(w, 1);
      await finish(w, f, 1, { outcome: 'scored', measures: MEASURES } as never);
      expect((await w.scope.evaluations.getById(w.evaluationId))?.status).toBe('completed');
    });

    it('is safe to call again', async () => {
      const w = await world({});
      const f = fakes();
      await claim(w, 0);
      const end = { outcome: 'scored', measures: MEASURES } as never;
      await finish(w, f, 0, end);
      await finish(w, f, 0, end);
      const rows = await w.scope.evaluationRuns.resultsForEvaluation(w.evaluationId);
      expect(rows).toHaveLength(1);
    });

    it('syncs again for a scored run without calls, then writes what is there', async () => {
      const w = await world({});
      const f = fakes();
      await claim(w, 0);
      await finishEvaluationRun(
        w.scope,
        {
          costController: f.costController,
          now: () => NOW,
          sleep: () => Promise.resolve(),
          costWait: { attempts: 2, intervalMs: 1 },
        },
        {
          evaluationRunId: w.runs[0]!,
          attempt: 1,
          keyIssuedAt: NOW,
          end: { outcome: 'scored', measures: MEASURES },
        },
      );
      expect(f.calls.synced).toBe(2);
      const [row] = await w.scope.evaluationRuns.resultsForEvaluation(w.evaluationId);
      expect(row).toMatchObject({ model_calls: 0, cost_usd: '0.000000' });
    });

    it('fails a failed run with the runner reason, and a lost run is queued again', async () => {
      const w = await world({});
      const f = fakes();
      await claim(w, 0);
      await finish(w, f, 0, { outcome: 'failed', reason: 'scoring_install_failed' } as never);
      expect(await w.scope.evaluationRuns.getById(w.runs[0]!)).toMatchObject({
        status: 'failed',
        stop_reason: 'scoring_install_failed',
      });
      await claim(w, 1);
      await finish(w, f, 1, { outcome: 'lost' } as never);
      expect(await w.scope.evaluationRuns.getById(w.runs[1]!)).toMatchObject({
        status: 'queued',
        attempt: 2,
      });
    });

    it(`a run lost ${String(MAX_EVALUATION_ATTEMPTS)} times fails for good`, async () => {
      const w = await world({});
      const f = fakes();
      for (let attempt = 1; attempt <= MAX_EVALUATION_ATTEMPTS; attempt += 1) {
        expect(await w.scope.evaluationRuns.claim(w.runs[0]!, attempt, 'sdlc')).toBe(true);
        await finishEvaluationRun(
          w.scope,
          { costController: f.costController, now: () => NOW },
          { evaluationRunId: w.runs[0]!, attempt, keyIssuedAt: NOW, end: { outcome: 'lost' } },
        );
      }
      expect(await w.scope.evaluationRuns.getById(w.runs[0]!)).toMatchObject({
        status: 'failed',
        stop_reason: 'runner_lost',
      });
    });

    it('a refused run gets its next attempt; a cancel before a runner took it ends the run', async () => {
      const w = await world({});
      const f = fakes();
      await finish(w, f, 0, { outcome: 'refused', reason: 'expired' } as never);
      expect((await w.scope.evaluationRuns.getById(w.runs[0]!))?.attempt).toBe(2);
      await finishEvaluationRun(
        w.scope,
        { costController: f.costController, now: () => NOW },
        {
          evaluationRunId: w.runs[1]!,
          attempt: 1,
          keyIssuedAt: NOW,
          end: { outcome: 'cancelled' },
        },
      );
      expect(await w.scope.evaluationRuns.getById(w.runs[1]!)).toMatchObject({
        status: 'cancelled',
        stop_reason: 'evaluation_stopped',
      });
    });

    it('stops the evaluation when the run used up the budget', async () => {
      const w = await world({ budget: '0.05' });
      const f = fakes();
      f.setSpend(() => addCost(w, w.runs[0]!, 1, '0.05'));
      await claim(w, 0);
      await finish(w, f, 0, { outcome: 'scored', measures: MEASURES } as never);
      expect(await w.scope.evaluations.getById(w.evaluationId)).toMatchObject({
        status: 'stopped_budget',
        stop_reason: 'budget_used',
      });
      expect((await w.scope.evaluationRuns.getById(w.runs[1]!))?.status).toBe('cancelled');
    });

    it('an evaluation where no run was scored ends failed', async () => {
      const w = await world({ runsPerTask: 1 });
      const f = fakes();
      await claim(w, 0);
      await finish(w, f, 0, { outcome: 'failed', reason: 'runner_error' } as never);
      expect(await w.scope.evaluations.getById(w.evaluationId)).toMatchObject({
        status: 'failed',
        stop_reason: 'no_run_scored',
      });
    });
  });

  describe('EvaluationLoop', () => {
    function makeLoop(w: SeededEvaluation, maxInFlight: number, dispatcher: FakeDispatcher) {
      const f = fakes();
      const loop = new EvaluationLoop({
        // Only this test's tenant: other tests leave open evaluations in the same database. The
        // test imports core from its sources, the worker from the build: same shapes.
        listTenants: () => Promise.resolve([w.scope.tenantId] as unknown as never[]),
        forTenant: (id) => t.app.forTenant(id as unknown as never) as unknown as TenantScope,
        prepare: (scope, id) => prepareEvaluationRun(scope as unknown as never, f.deps, id),
        dispatcher,
        logger: { log: () => undefined },
        maxInFlight,
      });
      return { loop, f };
    }

    it('hands over runs up to the limit, and no more while they wait', async () => {
      const w = await world({ runsPerTask: 3 });
      const dispatcher = new FakeDispatcher();
      const { loop } = makeLoop(w, 2, dispatcher);
      const pass = await loop.pass();
      expect(pass).toMatchObject({ handedOver: 2, failed: 0 });
      expect(dispatcher.started).toHaveLength(2);
      expect(JSON.stringify(dispatcher.started)).not.toContain('canary');
      expect(await loop.pass()).toMatchObject({ handedOver: 0 });
      expect(dispatcher.started).toHaveLength(2);
      // One run is claimed by a runner and scored; the room frees up for the third.
      const first = dispatcher.started[0]!;
      expect(await w.scope.evaluationRuns.claim(first.evaluationRunId, 1, 'sdlc')).toBe(true);
      await w.scope.evaluationRuns.markFailed(first.evaluationRunId, 'runner_error');
      dispatcher.live.delete(`${first.evaluationRunId}/1`);
      expect(await loop.pass()).toMatchObject({ handedOver: 1 });
    });

    it('gives a run without a live workflow its next attempt, then hands it over again', async () => {
      const w = await world({ runsPerTask: 1 });
      const dispatcher = new FakeDispatcher();
      const { loop } = makeLoop(w, 1, dispatcher);
      await loop.pass();
      dispatcher.live.clear();
      expect(await loop.pass()).toMatchObject({ requeued: 1 });
      expect((await w.scope.evaluationRuns.getById(w.runs[0]!))?.attempt).toBe(2);
      await loop.pass();
      expect(dispatcher.started.map((s) => s.attempt)).toEqual([1, 2]);
    });

    it('does not prepare an attempt while the workflow of the earlier one lives', async () => {
      const w = await world({ runsPerTask: 1 });
      const dispatcher = new FakeDispatcher();
      const { loop } = makeLoop(w, 1, dispatcher);
      expect(await w.scope.evaluationRuns.claim(w.runs[0]!, 1, 'sdlc')).toBe(true);
      await w.scope.evaluationRuns.markPreempted(w.runs[0]!);
      await w.scope.evaluationRuns.requeue(w.runs[0]!);
      dispatcher.live.add(`${w.runs[0]!}/1`);
      expect(await loop.pass()).toMatchObject({ handedOver: 0 });
      dispatcher.live.clear();
      expect(await loop.pass()).toMatchObject({ handedOver: 1 });
    });

    it('cancels the workflow of a run whose evaluation ended', async () => {
      const w = await world({ runsPerTask: 1 });
      const dispatcher = new FakeDispatcher();
      const { loop } = makeLoop(w, 1, dispatcher);
      expect(await w.scope.evaluationRuns.claim(w.runs[0]!, 1, 'sdlc')).toBe(true);
      await w.scope.evaluations.finish(w.evaluationId, 'cancelled', 'operator_stop');
      expect(await loop.pass()).toMatchObject({ stopped: 1 });
      expect(dispatcher.cancelled).toEqual([w.runs[0]]);
    });

    it(`cancels a run it could not hand over ${String(MAX_PREPARE_FAILURES)} times in a row`, async () => {
      const w = await world({ runsPerTask: 1 });
      const dispatcher = new FakeDispatcher();
      dispatcher.failStart = true;
      const { loop } = makeLoop(w, 1, dispatcher);
      for (let i = 0; i < MAX_PREPARE_FAILURES; i += 1) {
        await loop.pass();
        // The contract of the failed hand-over is of no use; the next pass gives the next attempt.
        await loop.pass();
      }
      expect(await w.scope.evaluationRuns.getById(w.runs[0]!)).toMatchObject({
        status: 'cancelled',
        stop_reason: 'prepare_failed',
      });
    });
  });
});
