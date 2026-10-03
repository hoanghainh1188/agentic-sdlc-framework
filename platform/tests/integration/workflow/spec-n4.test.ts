// D-08 B08 AC2 on Temporal, scenario N4 of D-09 (design/ADR-M39 §2.4): the spec is edited on the
// default branch after G2 was approved. The worker's spec check takes the intent back to G2; the
// new spec is approved again, and the intent goes on through G3 to G4. Run with
// `pnpm test:workflow`.
import { createHash } from 'node:crypto';
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
import { linkSpecFromGitHost } from '../../../packages/core/src/specs/link.js';
import { TemporalIntentSignals } from '../../../packages/workflow-client/src/index.js';
import { createTestDatabase, describeDb, type TestDatabase } from '../db/helpers.js';
import { FakeSpecGitHost, SPEC_PATH } from '../fake-spec-git-host.js';
import { createWorkflowFixture, PLAN_HASH, type WorkflowFixture } from './fixture.js';

const testServer = process.env.SDLC_TEMPORAL_TEST_SERVER;
const describeWorkflow = testServer ? describeDb : describe.skip;
const WORKFLOWS = path.resolve(__dirname, '../../../apps/worker/dist/workflows/index.js');
const T0 = new Date('2026-09-28T01:00:00.000Z');
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

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
  'B08: N4, the spec edited after G2, on Temporal',
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

    it('goes back to G2, voids the old approval, and continues once the new spec is approved', async () => {
      const intent = await f.newIntent({ riskTier: 'medium' });
      const ref = { tenantId: f.target.tenantId, intentId: intent.id };
      await signals.wake(ref);
      await at(intent, 'G1');
      await approve(intent, 'G1', 'a');
      await at(intent, 'G2');
      await linkSpecFromGitHost(
        f.scope,
        { gitHost: git },
        {
          intent: (await f.scope.intents.getById(intent.id))!,
          path: SPEC_PATH,
          actorId: f.users.a,
        },
      );
      await f.registry.submitPlan(f.scope, intent.id, {
        plannedFiles: ['apps/api/src/orders/**'],
        planSha256: PLAN_HASH,
        changeFlags: [],
        actorType: 'human',
        actorId: f.users.a,
      });
      await approve(intent, 'G2', 'a');
      await at(intent, 'G3');

      // N4: someone edits the spec on the default branch after G2.
      const edited = '# T07 Cancel an order\nAC1: stock returns.\nAC2: refund within 3 days.\n';
      git.commit({ [SPEC_PATH]: edited });
      await signals.wake(ref);
      await at(intent, 'G2');
      await waitFor(
        () => f.scope.gateDecisions.listForIntent(intent.id, 'G2'),
        (list) => list.some((d) => d.decision === 'void' && d.reason_code === 'input_mismatch'),
      );
      const notices = await f.scope.intentNotices.listForIntent(intent.id);
      expect(notices.map((n) => n.kind)).toContain('spec_changed');
      expect((await f.scope.specRefs.latest(intent.id))?.content_sha256).toBe(sha256(edited));

      await approve(intent, 'G2', 'a');
      await at(intent, 'G3');
      await approve(intent, 'G3', 'b');
      await at(intent, 'G4');
    });
  },
  180_000,
);
