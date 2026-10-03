// D-08 C11 AC2 on Temporal (design/ADR-M42 §2.2): the time-skipping test server with a throw-away
// PostgreSQL. Run with `pnpm test:workflow`.
//
// - a kill while the agent runs: the runner sees `stopping`, stops and ends the run
//   `stopped_killed`; the workflow revoked the key first (the diff of a killed run waits for that);
//   the intent is paused at G4 with the kill's escalation;
// - a kill while the run waits for a runner slot in Temporal: the kill signal cancels the activity,
//   which never starts; the other intent's run is not touched;
// - a kill when the runner dies before it ended the run: the activity fails, and `abandonRun`
//   ends the run `stopped_killed` (a heartbeat timeout takes the same path, tested in
//   run-handoff; the test server does not skip time while an activity's cancel is pending);
// - the histories (with the kill signal) replay on the current code; no secret in them.
// The runner here is a fake activity worker that acts like the real one on `stopping`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Context } from '@temporalio/activity';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode, Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createIntentActivities,
  type IntentActivityDeps,
} from '../../../apps/worker/src/activities/intent-activities.js';
import { startIntentWorker, type IntentWorkerHandle } from '../../../apps/worker/src/temporal.js';
import {
  intentWorkflowId,
  type IntentWorkflowRef,
} from '../../../packages/contracts/src/intent-workflow.js';
import {
  RUNNER_TASK_QUEUE,
  type ExecuteRunInput,
  type ExecuteRunResult,
} from '../../../packages/contracts/src/run-activity.js';
import type { Intent } from '../../../packages/core/src/db/schema.js';
import { requestRunKill } from '../../../packages/core/src/kill/index.js';
import { TemporalIntentSignals } from '../../../packages/workflow-client/src/index.js';
import { createTestDatabase, describeDb, type TestDatabase } from '../db/helpers.js';
import { atG4, harness, T0, type Harness } from '../g4-harness.js';

const testServer = process.env.SDLC_TEMPORAL_TEST_SERVER;
if (!testServer && process.env.SDLC_REQUIRE_DB === '1' && process.env.SDLC_WORKFLOW_TEST === '1') {
  throw new Error('SDLC_TEMPORAL_TEST_SERVER is not set (run: pnpm test:workflow)');
}
const describeWorkflow = testServer ? describeDb : describe.skip;

const WORKFLOWS = path.resolve(__dirname, '../../../apps/worker/dist/workflows/index.js');

async function waitFor<T>(read: () => Promise<T>, ok: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out; last value ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** `hold`: the run stays until the test releases it; `dies`: the runner dies at the kill. */
type Mode = 'hold' | 'dies';

describeWorkflow(
  'C11: the kill switch on Temporal',
  () => {
    let db: TestDatabase;
    let t: Harness;
    let env: TestWorkflowEnvironment;
    let bundlePath: string;
    let signals: TemporalIntentSignals;
    let intentWorker: IntentWorkerHandle | undefined;
    let runnerWorker: Worker | undefined;
    let runnerRunning: Promise<void> | undefined;
    const modes = new Map<string, Mode>();
    const released = new Set<string>();
    const started: string[] = [];
    /** Whether the run's key was already revoked when the runner ended a killed run. */
    const keyRevokedAtEnd = new Map<string, boolean>();

    /** The fake runner: like the real one, it stops a run that is `stopping`. */
    async function executeRun(input: ExecuteRunInput): Promise<ExecuteRunResult> {
      const scope = t.f.scope;
      const now = new Date();
      if (!(await scope.runs.claimForProvisioning(input.runId, now))) {
        return { outcome: 'refused', reason: 'run_not_startable' };
      }
      started.push(input.runId);
      await scope.runs.transition(input.runId, { from: ['provisioning'], to: 'running', now });
      const run = (await scope.runs.getById(input.runId))!;
      const mode = modes.get(run.intent_id) ?? 'hold';
      const ctx = Context.current();
      for (;;) {
        ctx.heartbeat();
        const current = (await scope.runs.getById(input.runId))!;
        if (current.status === 'stopping' && mode === 'dies') {
          // The runner process dies before it ends the run. It dies a second later, after the
          // workflow recorded its cancel request: the time-skipping test server rejects a workflow
          // task whose cancel request races with the activity's failure (`ACTIVITY_UNKNOWN`) and
          // never times that task out while time is locked. A real server buffers the failure and
          // retries the workflow task.
          await new Promise((resolve) => setTimeout(resolve, 1000));
          throw new Error('runner died');
        }
        if (current.status === 'stopping') {
          // The runner stops the agent, then waits for the key before it reads the workspace.
          await waitFor(
            () => Promise.resolve(t.calls.revoked.includes(input.runId)),
            (revoked) => revoked,
          ).catch(() => undefined);
          keyRevokedAtEnd.set(input.runId, t.calls.revoked.includes(input.runId));
          await scope.runs.transition(input.runId, {
            from: ['stopping'],
            to: 'stopped_killed',
            now: new Date(),
            stopReason: 'killed',
            finishedAt: new Date(),
          });
          return { outcome: 'ended', status: 'stopped_killed', stopReason: 'killed' };
        }
        if (released.has(run.intent_id)) {
          await scope.runs.transition(input.runId, {
            from: ['running'],
            to: 'failed',
            now: new Date(),
            stopReason: 'agent_error',
            finishedAt: new Date(),
          });
          return { outcome: 'ended', status: 'failed', stopReason: 'agent_error' };
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    const ref = (intent: Intent): IntentWorkflowRef => ({
      tenantId: t.f.target.tenantId,
      intentId: intent.id,
    });
    const reload = async (intent: Intent) => (await t.f.scope.intents.getById(intent.id))!;
    const until = (intent: Intent, status: string, gate: string) =>
      waitFor(
        () => reload(intent),
        (i) => i.status === status && i.current_gate === gate,
      );
    const firstRun = (intent: Intent) =>
      waitFor(
        () => t.f.scope.runs.listForIntent(intent.id),
        (runs) => runs.length > 0,
      ).then((runs) => runs[0]!);

    /** What the API does: record the kill, then the kill signal and a wake. */
    async function apiKill(intent: Intent, runId: string): Promise<void> {
      await requestRunKill(
        t.f.scope,
        { now: () => t.f.registry.now() },
        { runId, actor: { type: 'human', id: t.f.users.b }, source: 'api' },
      );
      await signals.kill(ref(intent));
      await signals.wake(ref(intent));
    }

    async function replays(intent: Intent): Promise<string> {
      const history = await env.client.workflow
        .getHandle(intentWorkflowId(ref(intent)))
        .fetchHistory();
      await expect(
        Worker.runReplayHistory({ workflowBundle: { codePath: bundlePath } }, history),
      ).resolves.toBeUndefined();
      return JSON.stringify(history, (key, value: unknown) => {
        if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
        return key === 'data' && typeof value === 'string'
          ? Buffer.from(value, 'base64').toString('utf8')
          : value;
      });
    }

    beforeAll(async () => {
      db = await createTestDatabase();
      t = await harness(db);
      env = await TestWorkflowEnvironment.createTimeSkipping({
        server: { executable: { type: 'existing-path', path: testServer! } },
      });
      const { code } = await bundleWorkflowCode({ workflowsPath: WORKFLOWS });
      bundlePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-kill-')), 'bundle.js');
      fs.writeFileSync(bundlePath, code);
      signals = new TemporalIntentSignals(env.client);
      intentWorker = await startIntentWorker({
        settings: { address: env.address, namespace: env.namespace ?? 'default' },
        workflowBundlePath: bundlePath,
        activities: createIntentActivities({
          db: db.app as unknown as IntentActivityDeps['db'],
          registry: t.f.registry as unknown as IntentActivityDeps['registry'],
          g4: t.g4,
          runs: t.runDeps as unknown as IntentActivityDeps['runs'],
        }),
      });
      // One slot, like `SDLC_RUNNER_MAX_SANDBOXES=1`.
      runnerWorker = await Worker.create({
        connection: env.nativeConnection,
        namespace: env.namespace ?? 'default',
        taskQueue: RUNNER_TASK_QUEUE,
        activities: { executeRun },
        maxConcurrentActivityTaskExecutions: 1,
      });
      runnerRunning = runnerWorker.run();
    }, 120_000);

    afterAll(async () => {
      runnerWorker?.shutdown();
      await runnerRunning?.catch(() => undefined);
      await intentWorker?.shutdown();
      await env?.teardown();
      await t?.f.close();
      await db?.drop();
    }, 60_000);

    it('a kill while the agent runs: the key is revoked first, the run ends stopped_killed, the intent is paused with the kill escalation', async () => {
      t.setClock(T0);
      const intent = await atG4(t, 'medium');
      await signals.wake(ref(intent));
      const run = await firstRun(intent);
      await waitFor(
        () => t.f.scope.runs.getById(run.id),
        (r) => r?.status === 'running',
      );
      await apiKill(intent, run.id);
      await until(intent, 'paused', 'G4');
      expect(await t.f.scope.runs.getById(run.id)).toMatchObject({
        status: 'stopped_killed',
        stop_reason: 'killed',
        killed_by: t.f.users.b,
      });
      // The workflow revoked the key on the kill signal, before the runner ended the run.
      expect(keyRevokedAtEnd.get(run.id)).toBe(true);
      const escalations = await t.f.scope.escalations.listForIntent(intent.id);
      expect(escalations).toHaveLength(1);
      expect(escalations[0]).toMatchObject({ route: 'technical', response_level: 'contain' });

      const text = await replays(intent);
      expect(text).toContain('"kill"');
      expect(text).not.toContain('sk-virtual');
      expect(text).not.toContain('ghs_token');
    });

    it('a kill while the run waits for a runner slot: the activity never starts; the other run is not touched', async () => {
      t.setClock(T0);
      const busy = await atG4(t, 'medium');
      const waiting = await atG4(t, 'medium');
      await signals.wake(ref(busy));
      const busyRun = await firstRun(busy);
      await waitFor(
        () => t.f.scope.runs.getById(busyRun.id),
        (r) => r?.status === 'running',
      );
      await signals.wake(ref(waiting));
      const queued = await firstRun(waiting);
      expect(queued.status).toBe('queued');

      await apiKill(waiting, queued.id);
      await until(waiting, 'paused', 'G4');
      expect(await t.f.scope.runs.getById(queued.id)).toMatchObject({
        status: 'stopped_killed',
        killed_by: t.f.users.b,
      });
      expect(started).not.toContain(queued.id);
      expect(t.calls.revoked).toContain(queued.id);
      // The busy run goes on.
      expect((await t.f.scope.runs.getById(busyRun.id))?.status).toBe('running');
      released.add(busy.id);
      await until(busy, 'paused', 'G4');
      expect(started).not.toContain(queued.id);
      await replays(waiting);
    });

    it('a kill when the runner dies before it ended the run: abandonRun ends it stopped_killed', async () => {
      t.setClock(T0);
      const intent = await atG4(t, 'medium');
      modes.set(intent.id, 'dies');
      await signals.wake(ref(intent));
      const run = await firstRun(intent);
      await waitFor(
        () => t.f.scope.runs.getById(run.id),
        (r) => r?.status === 'running',
      );
      await apiKill(intent, run.id);
      await until(intent, 'paused', 'G4');
      expect(await t.f.scope.runs.getById(run.id)).toMatchObject({
        status: 'stopped_killed',
        stop_reason: 'killed',
        killed_by: t.f.users.b,
      });
      const events = (await t.f.scope.runEvents.list(run.id)).map((e) => e.event_type);
      expect(events).toContain('run_abandoned');
      expect(t.calls.revoked).toContain(run.id);
      expect(await t.f.scope.escalations.listForIntent(intent.id)).toHaveLength(1);
      await replays(intent);
    });
  },
  120_000,
);
