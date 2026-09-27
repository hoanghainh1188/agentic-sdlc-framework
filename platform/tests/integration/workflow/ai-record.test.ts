// D-08 B12 AC2 on Temporal: the submit (Draft → G1) waits for a project AI record that allows the
// intent's data class (D-02 FR-19, design/ADR-M32 §2.5). Saving the record through the API wakes
// the draft intents; the workflow then submits. Run with `pnpm test:workflow`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TestWorkflowEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createIntentActivities,
  type IntentActivityDeps,
} from '../../../apps/worker/src/activities/intent-activities.js';
import { startIntentWorker, type IntentWorkerHandle } from '../../../apps/worker/src/temporal.js';
import type { Intent } from '../../../packages/core/src/db/schema.js';
import { TemporalIntentSignals } from '../../../packages/workflow-client/src/index.js';
import { createTestDatabase, describeDb, type TestDatabase } from '../db/helpers.js';
import { createWorkflowFixture, type WorkflowFixture } from './fixture.js';

const testServer = process.env.SDLC_TEMPORAL_TEST_SERVER;
const describeWorkflow = testServer ? describeDb : describe.skip;
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
  'B12: the AI record check at the submit, on Temporal',
  () => {
    let db: TestDatabase;
    let f: WorkflowFixture;
    let env: TestWorkflowEnvironment;
    let signals: TemporalIntentSignals;
    let worker: IntentWorkerHandle | undefined;

    beforeAll(async () => {
      db = await createTestDatabase();
      f = await createWorkflowFixture(db, () => T0);
      f.h.stub.now = T0;
      env = await TestWorkflowEnvironment.createTimeSkipping({
        server: { executable: { type: 'existing-path', path: testServer! } },
      });
      const { code } = await bundleWorkflowCode({ workflowsPath: WORKFLOWS });
      const bundlePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-wf-')), 'bundle.js');
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

    it('waits in draft until the record allows the data class, then enters G1', async () => {
      const projectId = f.target.projectId;
      const v1 = (await f.scope.projectAiRecords.get(projectId))!;
      await f.scope.projectAiRecords.save(projectId, {
        aiAllowed: 'yes',
        allowedDataClasses: ['public'],
        prodLogsAllowed: 'no',
        disclosureFormat: 'standard_note',
        confirmedAt: null,
        recordRef: null,
        updatedBy: f.users.a,
        actorType: 'human',
        expectedVersion: v1.version,
      });
      const intent: Intent = await f.newIntent(); // data class `internal`
      const ref = { tenantId: f.target.tenantId, intentId: intent.id };
      await signals.wake(ref);
      await waitFor(
        () => f.scope.gateDecisions.listForIntent(intent.id, 'G1'),
        (list) => list.some((d) => d.decision === 'fail'),
      );
      expect((await f.scope.intents.getById(intent.id))!).toMatchObject({ status: 'draft' });

      await f.scope.projectAiRecords.save(projectId, {
        aiAllowed: 'yes',
        allowedDataClasses: ['public', 'internal'],
        prodLogsAllowed: 'no',
        disclosureFormat: 'standard_note',
        confirmedAt: null,
        recordRef: null,
        updatedBy: f.users.a,
        actorType: 'human',
        expectedVersion: v1.version + 1,
      });
      await signals.wake(ref); // the API wakes the project's drafts after a save
      await waitFor(
        () => f.scope.intents.getById(intent.id),
        (i) => i?.status === 'in_gate' && i.current_gate === 'G1',
      );
    });
  },
  180_000,
);
