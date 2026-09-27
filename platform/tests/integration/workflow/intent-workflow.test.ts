// D-08 B07 AC1 and AC5 on Temporal (session 1): the intent workflow runs on the Temporal test
// server (time-skipping, pinned by version and SHA-256: platform/deploy/scripts/
// temporal-test-server.sh) with a throw-away PostgreSQL. Run with `pnpm test:workflow`.
//
// - AC1: Draft → G1 → G2 → G3 → (G4) on people's decisions, woken by the poller's and the api's
//   signals; a rejection ends the workflow.
// - AC5: a worker stopped while the intent waits; a new worker continues in the right state. A wake
//   signal lost between a commit and the signal is caught up by the reconcile loop.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TestWorkflowEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode, Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createIntentActivities,
  type IntentActivityDeps,
} from '../../../apps/worker/src/activities/intent-activities.js';
import { ReconcileLoop } from '../../../apps/worker/src/reconcile-loop.js';
import { startIntentWorker, type IntentWorkerHandle } from '../../../apps/worker/src/temporal.js';
import {
  intentWorkflowId,
  type IntentWorkflowRef,
} from '../../../packages/contracts/src/intent-workflow.js';
import type { Intent } from '../../../packages/core/src/db/schema.js';
import { TemporalIntentSignals } from '../../../packages/workflow-client/src/index.js';
import { createTestDatabase, describeDb, type TestDatabase } from '../db/helpers.js';
import { createWorkflowFixture, type WorkflowFixture } from './fixture.js';

const testServer = process.env.SDLC_TEMPORAL_TEST_SERVER;
if (!testServer && process.env.SDLC_REQUIRE_DB === '1' && process.env.SDLC_WORKFLOW_TEST === '1') {
  throw new Error('SDLC_TEMPORAL_TEST_SERVER is not set (run: pnpm test:workflow)');
}
const describeWorkflow = testServer ? describeDb : describe.skip;

/** The compiled workflow code (`pnpm build` first); bundled once, like the worker image. */
const WORKFLOWS = path.resolve(__dirname, '../../../apps/worker/dist/workflows/index.js');
const T0 = new Date('2026-09-28T01:00:00.000Z');

async function waitFor<T>(read: () => Promise<T>, ok: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out; last value ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describeWorkflow(
  'B07: the intent workflow on Temporal',
  () => {
    let db: TestDatabase;
    let f: WorkflowFixture;
    let env: TestWorkflowEnvironment;
    let bundlePath: string;
    let signals: TemporalIntentSignals;
    let worker: IntentWorkerHandle | undefined;

    const ref = (intent: Intent): IntentWorkflowRef => ({
      tenantId: f.target.tenantId,
      intentId: intent.id,
    });
    const reload = async (intent: Intent) => (await f.scope.intents.getById(intent.id))!;
    const atGate = (intent: Intent, gate: string) =>
      waitFor(
        () => reload(intent),
        (i) => i.status === 'in_gate' && i.current_gate === gate,
      );
    /**
     * A worker like the worker process: its own connection to the frontend. `maxCachedWorkflows`
     * 0: no workflow cache, so every task replays the history, as after a process restart.
     */
    const startWorker = (maxCachedWorkflows?: number) =>
      startIntentWorker({
        settings: { address: env.address, namespace: env.namespace ?? 'default' },
        ...(maxCachedWorkflows === undefined ? {} : { maxCachedWorkflows }),
        workflowBundlePath: bundlePath,
        // The worker code imports the built `@sdlc/core`; the fixture uses its sources (same shapes).
        activities: createIntentActivities({
          db: db.app as unknown as IntentActivityDeps['db'],
          registry: f.registry as unknown as IntentActivityDeps['registry'],
        }),
      });

    beforeAll(async () => {
      db = await createTestDatabase();
      f = await createWorkflowFixture(db, () => T0);
      f.h.stub.now = T0;
      env = await TestWorkflowEnvironment.createTimeSkipping({
        server: { executable: { type: 'existing-path', path: testServer! } },
      });
      const { code } = await bundleWorkflowCode({ workflowsPath: WORKFLOWS });
      bundlePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-wf-')), 'bundle.js');
      fs.writeFileSync(bundlePath, code);
      signals = new TemporalIntentSignals(env.client);
      worker = await startWorker();
    }, 120_000);

    afterAll(async () => {
      await worker?.shutdown();
      await env?.teardown();
      await f?.close();
      await db?.drop();
    }, 60_000);

    describe('AC1: the D-03 state machine, woken by signals', () => {
      it('creating the intent starts the workflow; each approval moves one gate', async () => {
        const intent = await f.newIntent();
        // The api wakes the workflow after the create (signal-with-start): the submit.
        await signals.wake(ref(intent));
        await atGate(intent, 'G1');

        f.comment(intent, '/approve G1', 'a');
        await f.poll(signals); // records the decision, then wakes the workflow
        await atGate(intent, 'G2');

        await f.addInputs(intent);
        await signals.wake(ref(intent));
        f.comment(intent, '/approve G2', 'a');
        await f.poll(signals);
        await atGate(intent, 'G3');

        f.comment(intent, '/approve G3', 'b');
        await f.poll(signals);
        await atGate(intent, 'G4');

        // The workflow keeps running at G4: C06 continues from there.
        const handle = env.client.workflow.getHandle(intentWorkflowId(ref(intent)));
        expect((await handle.describe()).status.name).toBe('RUNNING');
        // Only IDs in Temporal: the workflow input holds no client data.
        const history = await handle.fetchHistory();
        const input = JSON.stringify(history.events?.[0]);
        expect(input).not.toContain('Cancel an order');
      });

      it('a rejection ends the workflow with the status', async () => {
        const intent = await f.newIntent();
        await signals.wake(ref(intent));
        await atGate(intent, 'G1');
        f.comment(intent, '/reject G1 spec_unclear', 'a');
        await f.poll(signals);
        const handle = env.client.workflow.getHandle(intentWorkflowId(ref(intent)));
        await expect(handle.result()).resolves.toBe('rejected');
        expect(await reload(intent)).toMatchObject({ status: 'rejected' });
      });

      it('repeated wake signals are harmless: one move, one notice', async () => {
        const intent = await f.newIntent();
        await Promise.all([1, 2, 3, 4, 5].map(() => signals.wake(ref(intent))));
        await atGate(intent, 'G1');
        await Promise.all([1, 2, 3].map(() => signals.wake(ref(intent))));
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(await reload(intent)).toMatchObject({ current_gate: 'G1' });
        expect(await f.scope.intentNotices.listForIntent(intent.id)).toHaveLength(1);
      });
    });

    describe('AC5: a worker restart mid-way continues in the right state', () => {
      it('the intent waits at G2 while no worker runs; a new worker moves it on', async () => {
        // Workers without a workflow cache: every task replays the history, as after a process
        // restart. (With a cache, a stopped worker's sticky queue holds the next task until its
        // schedule-to-start timeout; the Java test server does not hand it over.)
        await worker!.shutdown();
        worker = await startWorker(0);
        const intent = await f.newIntent();
        await signals.wake(ref(intent));
        await atGate(intent, 'G1');
        f.comment(intent, '/approve G1', 'a');
        await f.poll(signals);
        await atGate(intent, 'G2');
        await f.addInputs(intent);

        await worker.shutdown();
        worker = undefined;
        // Decided and signalled while no worker runs: Temporal keeps the signal.
        f.comment(intent, '/approve G2', 'a');
        await f.poll(signals);
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(await reload(intent)).toMatchObject({ current_gate: 'G2' });

        worker = await startWorker(0);
        await atGate(intent, 'G3');
        const notices = await f.scope.intentNotices.listForIntent(intent.id);
        expect(notices.map((n) => n.gate)).toEqual(['G1', 'G2', 'G3']);
      });

      it('the recorded history replays on the current workflow code (determinism)', async () => {
        const intent = await f.newIntent();
        await signals.wake(ref(intent));
        await atGate(intent, 'G1');
        f.comment(intent, '/reject G1 out_of_scope', 'a');
        await f.poll(signals);
        const handle = env.client.workflow.getHandle(intentWorkflowId(ref(intent)));
        await handle.result();
        const history = await handle.fetchHistory();
        await expect(
          Worker.runReplayHistory({ workflowBundle: { codePath: bundlePath } }, history),
        ).resolves.toBeUndefined();
      });

      it('a wake signal lost after the commit is caught up by the reconcile loop', async () => {
        const intent = await f.newIntent();
        await signals.wake(ref(intent));
        await atGate(intent, 'G1');
        // The poller commits the decision but its process stops before the signal.
        f.comment(intent, '/approve G1', 'a');
        await f.poll();
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(await reload(intent)).toMatchObject({ current_gate: 'G1' });

        const logs: string[] = [];
        const reconcile = new ReconcileLoop({
          listOpen: (limit, after) => db.app.system.listOpenIntents(limit, after),
          signals,
          logger: { log: (_level, event) => logs.push(event) },
          batchSize: 2,
        });
        const pass = await reconcile.pass();
        expect(pass.failed).toBe(0);
        expect(pass.woken).toBeGreaterThanOrEqual(1);
        expect(logs).toContain('worker.reconciled');
        await atGate(intent, 'G2');
      });

      it('an intent created while Temporal was down is started by the reconcile loop', async () => {
        const intent = await f.newIntent(); // no signal: the api could not reach Temporal
        const reconcile = new ReconcileLoop({
          listOpen: (limit, after) => db.app.system.listOpenIntents(limit, after),
          signals,
          logger: { log: () => undefined },
          batchSize: 50,
        });
        await reconcile.pass();
        await atGate(intent, 'G1');
      });
    });
  },
  60_000,
);
