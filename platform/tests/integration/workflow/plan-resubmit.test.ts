// D-08 B09 AC3 on Temporal (design/ADR-M40 §2.4, QUESTIONS #167): the plan file is edited on the
// default branch after G3 was approved, while the intent waits at G4. The worker's plan check
// holds G4 until Person A submits the plan again; the new plan takes the intent back to G3, where
// Person B approves it, and the intent returns to G4. Run with `pnpm test:workflow`.
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
import { decideGate } from '../../../packages/core/src/commands/gate-command.js';
import type { Intent } from '../../../packages/core/src/db/schema.js';
import { planPath } from '../../../packages/core/src/plans/rules.js';
import { submitPlanFromGitHost } from '../../../packages/core/src/plans/submit.js';
import { linkSpecFromGitHost } from '../../../packages/core/src/specs/link.js';
import { TemporalIntentSignals } from '../../../packages/workflow-client/src/index.js';
import { createTestDatabase, describeDb, type TestDatabase } from '../db/helpers.js';
import { FakeSpecGitHost, SPEC_PATH } from '../fake-spec-git-host.js';
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

const planYaml = (code: string, paths: readonly string[]) =>
  [
    'plan:',
    `  intent_id: ${code}`,
    'tasks:',
    '  - id: T1',
    `    allowed_paths: [${paths.join(', ')}]`,
    '    tools: [file_editor, terminal]',
    '',
  ].join('\n');

describeWorkflow(
  'B09: the plan edited after G3, on Temporal',
  () => {
    let db: TestDatabase;
    let f: WorkflowFixture;
    let git: FakeSpecGitHost;
    let env: TestWorkflowEnvironment;
    let signals: TemporalIntentSignals;
    let worker: IntentWorkerHandle | undefined;

    beforeAll(async () => {
      db = await createTestDatabase();
      f = await createWorkflowFixture(db, () => T0);
      f.h.stub.now = T0;
      git = new FakeSpecGitHost();
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
          specs: { gitHost: git },
        }),
      });
    }, 120_000);

    afterAll(async () => {
      await worker?.shutdown();
      await env?.teardown();
      await f?.close();
      await db?.drop();
    }, 60_000);

    const at = (intent: Intent, gate: string) =>
      waitFor(
        () => f.scope.intents.getById(intent.id),
        (i) => i?.status === 'in_gate' && i.current_gate === gate,
      );

    async function approve(intent: Intent, gate: 'G1' | 'G2' | 'G3', who: 'a' | 'b') {
      await decideGate(f.registry, f.scope, {
        intent: (await f.scope.intents.getById(intent.id))!,
        gate,
        decision: 'approve',
        actorId: f.users[who],
        reasonCode: null,
        source: 'cli',
      });
      await signals.wake({ tenantId: f.target.tenantId, intentId: intent.id });
    }

    it('holds G4 until the plan is submitted again, then G3 decides the new plan', async () => {
      const intent = await f.newIntent({ riskTier: 'medium' });
      const ref = { tenantId: f.target.tenantId, intentId: intent.id };
      const current = async () => (await f.scope.intents.getById(intent.id))!;
      await signals.wake(ref);
      await at(intent, 'G1');
      await approve(intent, 'G1', 'a');
      await at(intent, 'G2');
      await linkSpecFromGitHost(
        f.scope,
        { gitHost: git },
        { intent: await current(), path: SPEC_PATH, actorId: f.users.a },
      );
      git.commit({ [planPath(intent.code)]: planYaml(intent.code, ['apps/api/src/orders/**']) });
      await submitPlanFromGitHost(
        f.scope,
        { gitHost: git },
        { intent: await current(), actorId: f.users.a },
      );
      await approve(intent, 'G2', 'a');
      await at(intent, 'G3');
      await approve(intent, 'G3', 'b');
      await at(intent, 'G4');

      // The plan file is edited on the default branch after G3: G4 is held, no run starts.
      git.commit({ [planPath(intent.code)]: planYaml(intent.code, ['apps/api/src/**']) });
      await signals.wake(ref);
      await waitFor(
        () => f.scope.audit.listForEntity(intent.id, ['plan.resubmit_needed']),
        (events) => events.length === 1,
      );
      expect(await current()).toMatchObject({ status: 'in_gate', current_gate: 'G4' });

      // Person A submits it again: back to G3, the old approval is void, Person B decides again.
      await submitPlanFromGitHost(
        f.scope,
        { gitHost: git },
        { intent: await current(), actorId: f.users.a },
      );
      await signals.wake(ref);
      await at(intent, 'G3');
      await waitFor(
        () => f.scope.gateDecisions.listForIntent(intent.id, 'G3'),
        (list) => list.some((d) => d.decision === 'void' && d.reason_code === 'input_mismatch'),
      );
      const notices = await f.scope.intentNotices.listForIntent(intent.id);
      expect(notices.map((n) => n.kind)).toEqual(
        expect.arrayContaining(['plan_resubmit_needed', 'plan_changed']),
      );
      expect(await f.scope.plans.list(intent.id)).toHaveLength(2);
      await approve(intent, 'G3', 'b');
      await at(intent, 'G4');
    });
  },
  180_000,
);
