// D-08 L04 (PR 4d) on Temporal (design/ADR-M81 §2.8): the time-skipping test server with a
// throw-away PostgreSQL. Run with `pnpm test:workflow`.
//
// - a scored run: the runner leaves the run `running`, the workflow has the worker finish it: the
//   result with the cost is written, the key is revoked, and the evaluation ends when its last run
//   is scored;
// - a runner that dies: the workflow says `lost`, and the run is queued again (next attempt);
// - a cancel while the agent runs (the evaluation ended): the runner stops, the run is `cancelled`;
// - starting the same attempt twice starts one workflow; the history holds no secret and replays.
// The runner here is a fake activity worker on the task queue `sdlc-runner-eval`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  EVALUATION_RUNNER_TASK_QUEUE,
  evaluationRunWorkflowId,
  type EvaluationScoredMeasures,
  type ExecuteEvaluationRunInput,
  type ExecuteEvaluationRunResult,
} from '@sdlc/contracts';
import { Context } from '@temporalio/activity';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode, Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createIntentActivities,
  type IntentActivityDeps,
} from '../../../apps/worker/src/activities/intent-activities.js';
import { startIntentWorker, type IntentWorkerHandle } from '../../../apps/worker/src/temporal.js';
import { TemporalEvaluationDispatcher } from '../../../packages/workflow-client/src/index.js';
import { seedEvaluation, type SeededEvaluation } from '../evaluation-seed.js';
import { createTestDatabase, describeDb, type TestDatabase } from '../db/helpers.js';

const testServer = process.env.SDLC_TEMPORAL_TEST_SERVER;
if (!testServer && process.env.SDLC_REQUIRE_DB === '1' && process.env.SDLC_WORKFLOW_TEST === '1') {
  throw new Error('SDLC_TEMPORAL_TEST_SERVER is not set (run: pnpm test:workflow)');
}
const describeWorkflow = testServer ? describeDb : describe.skip;

const WORKFLOWS = path.resolve(__dirname, '../../../apps/worker/dist/workflows/index.js');
const NOW = new Date('2026-10-14T08:00:00.000Z');
const MEASURES: EvaluationScoredMeasures = {
  agentOutcome: 'finished',
  status: 'succeeded',
  stopReason: null,
  seconds: 10,
  iterations: 4,
  outOfPlanFiles: 0,
  diffFiles: 1,
  diffLinesAdded: 2,
  diffLinesRemoved: 0,
  applied: true,
  ci: true,
  passToPass: true,
  failToPass: true,
  lintFindings: 0,
  instructionsSha256: 'b'.repeat(64),
  hardware: {
    cpu_model: 'Test CPU',
    cpu_cores: 4,
    memory_gb: 16,
    docker_version: '27.0.1',
    gpu: null,
    runner_instance: 'sdlc',
  },
};

async function waitFor<T>(read: () => Promise<T>, ok: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out; last value ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

type Mode = 'score' | 'die' | 'hold';

describeWorkflow(
  'L04: the evaluation run workflow on Temporal',
  () => {
    let db: TestDatabase;
    let env: TestWorkflowEnvironment;
    let bundlePath: string;
    let intentWorker: IntentWorkerHandle | undefined;
    let runnerWorker: Worker | undefined;
    let runnerRunning: Promise<void> | undefined;
    let dispatcher: TemporalEvaluationDispatcher;
    let world: SeededEvaluation;
    const modes = new Map<string, Mode>();
    const revoked: string[] = [];
    let tenants = 0;

    /** The fake runner: it claims the run, then acts by mode. */
    async function executeEvaluationRun(
      input: ExecuteEvaluationRunInput,
    ): Promise<ExecuteEvaluationRunResult> {
      const scope = world.scope;
      if (!(await scope.evaluationRuns.claim(input.evaluationRunId, input.attempt, 'sdlc'))) {
        return { outcome: 'refused', reason: 'run_not_startable' };
      }
      const mode = modes.get(input.evaluationRunId) ?? 'score';
      if (mode === 'die') throw new Error('runner died');
      if (mode === 'hold') {
        const ctx = Context.current();
        while (!ctx.cancellationSignal.aborted) {
          ctx.heartbeat();
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        await scope.evaluationRuns.markCancelled(input.evaluationRunId, 'evaluation_stopped');
        return { outcome: 'cancelled' };
      }
      return { outcome: 'scored', measures: MEASURES };
    }

    const input = (runId: string, attempt = 1) => ({
      tenantId: world.scope.tenantId,
      evaluationRunId: runId,
      attempt,
      wrappedGitToken: 'wrap-git-token',
      wrappedVirtualKey: 'wrap-virtual-key',
      keyIssuedAt: NOW.toISOString(),
    });

    beforeAll(async () => {
      db = await createTestDatabase();
      env = await TestWorkflowEnvironment.createTimeSkipping({
        server: { executable: { type: 'existing-path', path: testServer! } },
      });
      const { code } = await bundleWorkflowCode({ workflowsPath: WORKFLOWS });
      bundlePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-evalwf-')), 'bundle.js');
      fs.writeFileSync(bundlePath, code);
      dispatcher = new TemporalEvaluationDispatcher(env.client);
      intentWorker = await startIntentWorker({
        settings: { address: env.address, namespace: env.namespace ?? 'default' },
        workflowBundlePath: bundlePath,
        activities: createIntentActivities({
          db: db.app as unknown as IntentActivityDeps['db'],
          registry: {} as unknown as IntentActivityDeps['registry'],
          evaluations: {
            costController: {
              endRunKey: (i: { runId: string }) => {
                revoked.push(i.runId);
                return Promise.resolve({ seen: 0, inserted: 0, duplicates: 0, skipped: {} });
              },
              syncSpend: () =>
                Promise.resolve({ seen: 0, inserted: 0, duplicates: 0, skipped: {} }),
            } as unknown as NonNullable<IntentActivityDeps['evaluations']>['costController'],
            now: () => NOW,
            sleep: () => Promise.resolve(),
            costWait: { attempts: 0, intervalMs: 0 },
          },
        }),
      });
      runnerWorker = await Worker.create({
        connection: env.nativeConnection,
        namespace: env.namespace ?? 'default',
        taskQueue: EVALUATION_RUNNER_TASK_QUEUE,
        activities: { executeEvaluationRun },
        // Like the runner: a cancel reaches the activity on the next heartbeat.
        maxHeartbeatThrottleInterval: '100ms',
        defaultHeartbeatThrottleInterval: '100ms',
      });
      runnerRunning = runnerWorker.run();
    }, 120_000);

    afterAll(async () => {
      runnerWorker?.shutdown();
      await runnerRunning?.catch(() => undefined);
      await intentWorker?.shutdown();
      await env?.teardown();
      await db?.drop();
    }, 60_000);

    const fresh = async () => {
      world = await seedEvaluation(db.app, { slug: `wf-${String(++tenants)}` });
      return world;
    };

    it('a scored run is finished by the worker: result, revoked key, evaluation completed', async () => {
      const w = await fresh();
      for (const id of w.runs) await dispatcher.start(input(id));
      // The same attempt twice starts one workflow.
      await dispatcher.start(input(w.runs[0]!));
      await waitFor(
        () => w.scope.evaluations.getById(w.evaluationId),
        (e) => e?.status === 'completed',
      );
      const results = await w.scope.evaluationRuns.resultsForEvaluation(w.evaluationId);
      expect(results).toHaveLength(2);
      expect(results[0]).toMatchObject({ resolved: true, outcome: 'finished' });
      expect(revoked.sort()).toEqual([...w.runs].sort());
      // The evaluation is marked completed inside the last activity; the workflow closes only
      // after that activity returns. Wait for each workflow to close before checking it.
      for (const id of w.runs) {
        await env.client.workflow.getHandle(evaluationRunWorkflowId(input(id))).result();
      }
      expect(await dispatcher.isRunning({ ...input(w.runs[0]!) })).toBe(false);

      const history = await env.client.workflow
        .getHandle(evaluationRunWorkflowId(input(w.runs[0]!)))
        .fetchHistory();
      await expect(
        Worker.runReplayHistory({ workflowBundle: { codePath: bundlePath } }, history),
      ).resolves.toBeUndefined();
      const text = JSON.stringify(history, (key, value: unknown) =>
        key === 'data' && typeof value === 'string'
          ? Buffer.from(value, 'base64').toString('utf8')
          : value,
      );
      expect(text).toContain('wrap-git-token');
      expect(text).not.toContain('sk-');
      expect(text).not.toContain('ghs_');
    });

    it('a runner that dies: the run is queued again with the next attempt', async () => {
      const w = await fresh();
      modes.set(w.runs[0]!, 'die');
      await dispatcher.start(input(w.runs[0]!));
      await waitFor(
        () => w.scope.evaluationRuns.getById(w.runs[0]!),
        (r) => r?.status === 'queued' && r.attempt === 2,
      );
      expect(revoked).toContain(w.runs[0]);
      expect(await w.scope.evaluationRuns.resultsForEvaluation(w.evaluationId)).toHaveLength(0);
    });

    it('a cancel while the agent runs: the runner stops and the run is cancelled', async () => {
      const w = await fresh();
      modes.set(w.runs[0]!, 'hold');
      await dispatcher.start(input(w.runs[0]!));
      await waitFor(
        () => w.scope.evaluationRuns.getById(w.runs[0]!),
        (r) => r?.status === 'running',
      );
      await dispatcher.cancel(input(w.runs[0]!));
      await waitFor(
        () => w.scope.evaluationRuns.getById(w.runs[0]!),
        (r) => r?.status === 'cancelled',
      );
      expect((await w.scope.evaluationRuns.getById(w.runs[0]!))?.stop_reason).toBe(
        'evaluation_stopped',
      );
      expect(await w.scope.evaluationRuns.resultsForEvaluation(w.evaluationId)).toHaveLength(0);
    });
  },
  120_000,
);
