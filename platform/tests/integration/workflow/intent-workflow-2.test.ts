// D-08 B07 session 2 on Temporal (design/ADR-M30 §2.4b, §2.9): the time-skipping test server
// (pinned: platform/deploy/scripts/temporal-test-server.sh) with a throw-away PostgreSQL. Run with
// `pnpm test:workflow`.
//
// - AC2: Low risk G2 and G3 pass on HOTL end to end; a block within the window, read from a
//   comment, brings the workflow back to the passed gate.
// - AC4: the gate deadline is the workflow's one timer: with no decision and no signal, the
//   workflow wakes at the deadline and raises one escalation; the approval closes it. The history
//   with the timer replays on the current code.
//
// Its own test environment: the session 1 file stops a worker on purpose (AC5), and the Java test
// server does not hand that worker's sticky tasks over, which would block the time skipping here.
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

const WORKFLOWS = path.resolve(__dirname, '../../../apps/worker/dist/workflows/index.js');
const T0 = new Date('2026-09-28T01:00:00.000Z');
/** 1 working day from T0 on the default calendar: 09:00–18:00 in Ho Chi Minh City = 11:00 UTC. */
const GATE_DEADLINE = new Date('2026-09-28T11:00:00.000Z');

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
  'B07 session 2: HOTL gates and the gate deadline on Temporal',
  () => {
    let db: TestDatabase;
    let f: WorkflowFixture;
    let env: TestWorkflowEnvironment;
    let bundlePath: string;
    let signals: TemporalIntentSignals;
    let worker: IntentWorkerHandle | undefined;
    /** The registry clock of the activities; the tests move it together with the Temporal time. */
    let clock = T0;

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

    beforeAll(async () => {
      db = await createTestDatabase();
      f = await createWorkflowFixture(db, () => clock);
      f.h.stub.now = T0;
      env = await TestWorkflowEnvironment.createTimeSkipping({
        server: { executable: { type: 'existing-path', path: testServer! } },
      });
      const { code } = await bundleWorkflowCode({ workflowsPath: WORKFLOWS });
      bundlePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-wf2-')), 'bundle.js');
      fs.writeFileSync(bundlePath, code);
      signals = new TemporalIntentSignals(env.client);
      worker = await startIntentWorker({
        settings: { address: env.address, namespace: env.namespace ?? 'default' },
        workflowBundlePath: bundlePath,
        activities: createIntentActivities({
          db: db.app as unknown as IntentActivityDeps['db'],
          registry: f.registry as unknown as IntentActivityDeps['registry'],
        }),
      });
    }, 120_000);

    afterAll(async () => {
      await worker?.shutdown();
      await env?.teardown();
      await f?.close();
      await db?.drop();
    }, 60_000);

    it('Low risk: G2 and G3 pass on HOTL; a block within the window brings the intent back', async () => {
      const intent = await f.newIntent({ riskTier: 'low' });
      await signals.wake(ref(intent));
      await atGate(intent, 'G1');
      f.comment(intent, '/approve G1', 'a');
      await f.poll(signals);
      await atGate(intent, 'G2');

      await f.addInputs(intent);
      await signals.wake(ref(intent)); // what B08 and B09 do after linking the inputs
      await atGate(intent, 'G4');
      const kinds = (await f.scope.intentNotices.listForIntent(intent.id)).map((n) => n.kind);
      expect(kinds).toEqual(['submitted', 'advanced', 'hotl_passed', 'hotl_passed']);

      // Person B sends G3 back within its block window, with a comment read by the poller.
      f.comment(intent, '/request-changes G3 tests_insufficient', 'b');
      await f.poll(signals);
      await atGate(intent, 'G3');
      const last = (await f.scope.intentNotices.listForIntent(intent.id)).at(-1)!;
      expect([last.kind, last.previous_gate]).toEqual(['returned', 'G4']);
    });

    it('the deadline timer raises one escalation without a signal; the approval closes it', async () => {
      const intent = await f.newIntent();
      await signals.wake(ref(intent));
      await atGate(intent, 'G1');
      expect(await f.scope.escalations.listForIntent(intent.id)).toEqual([]);

      // Only time passes: no decision, no signal. The workflow's timer wakes it at the deadline.
      clock = GATE_DEADLINE;
      await env.sleep(GATE_DEADLINE.getTime() - T0.getTime() + 1_000);
      const [overdue] = await waitFor(
        () => f.scope.escalations.listForIntent(intent.id),
        (rows) => rows.length > 0,
      );
      expect(overdue).toMatchObject({ trigger: 'time', route: 'intent', status: 'open' });
      // Once only, however often the workflow is woken.
      await signals.wake(ref(intent));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await f.scope.escalations.listForIntent(intent.id)).toHaveLength(1);

      f.comment(intent, '/approve G1', 'a');
      await f.poll(signals);
      await atGate(intent, 'G2');
      expect((await f.scope.escalations.getById(overdue!.id))?.status).toBe('closed');

      // The history with the timer replays on the current workflow code.
      await f.addInputs(intent);
      f.comment(intent, '/reject G2 out_of_scope', 'a');
      await f.poll(signals);
      const handle = env.client.workflow.getHandle(intentWorkflowId(ref(intent)));
      expect(await handle.result()).toBe('rejected');
      const history = await handle.fetchHistory();
      expect(history.events?.some((e) => e.timerStartedEventAttributes)).toBe(true);
      await expect(
        Worker.runReplayHistory({ workflowBundle: { codePath: bundlePath } }, history),
      ).resolves.toBeUndefined();
    });
  },
  60_000,
);
