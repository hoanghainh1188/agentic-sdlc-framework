// D-08 C06 AC4 (session 2a) on Temporal (design/ADR-M33 §2.6–§2.7, QUESTIONS #53, #55): the
// time-skipping test server with a throw-away PostgreSQL. Run with `pnpm test:workflow`.
//
// - G4 decided → `running` → `prepareRun` → `executeRun` on the task queue `sdlc-runner` →
//   `finishRun` → G5, end to end;
// - the runner worker's activity slots are the sandbox limit: with one slot, a second run waits in
//   Temporal;
// - a contract that expired while its run waited is refused by the runner; the workflow cancels
//   the run (`contract_expired`) and issues a new attempt;
// - a lost runner (no heartbeat) → `abandonRun`: the key is revoked at once, the run fails
//   (`runner_lost`), the intent is paused with a technical escalation;
// - the history replays on the current code.
// C07 PR 2 (design/ADR-M34 §2.8, D-09 N1, N3): G5 in the workflow:
// - a succeeded run in scope passes G5 (HOTL) and waits at G6;
// - N1: changes outside the plan → G5 fails → back to G3;
// - N3: the cost cap → G5 fails → paused at G5 with an `intent` escalation at `pause`; `resume`
//   with a budget increase → G4 → a new run with the new cap → G5 → G6; the history replays.
// The runner here is a fake activity worker: provisioning and the agent are C04 and C05's tests.
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
import {
  acknowledgeEscalation,
  decideEscalation,
} from '../../../packages/core/src/escalation/decide.js';
import { TemporalIntentSignals } from '../../../packages/workflow-client/src/index.js';
import { createTestDatabase, describeDb, type TestDatabase } from '../db/helpers.js';
import { atG4, harness, T0, type Harness } from '../g4-harness.js';

const testServer = process.env.SDLC_TEMPORAL_TEST_SERVER;
if (!testServer && process.env.SDLC_REQUIRE_DB === '1' && process.env.SDLC_WORKFLOW_TEST === '1') {
  throw new Error('SDLC_TEMPORAL_TEST_SERVER is not set (run: pnpm test:workflow)');
}
const describeWorkflow = testServer ? describeDb : describe.skip;

const WORKFLOWS = path.resolve(__dirname, '../../../apps/worker/dist/workflows/index.js');
const MINUTE = 60_000;

async function waitFor<T>(read: () => Promise<T>, ok: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out; last value ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

type Mode = 'succeed' | 'expire_once' | 'lost';

/** How the fake runner ends a run, and the changes it records (C07: `changes_checked`). */
interface RunOutcome {
  readonly status: 'succeeded' | 'stopped_budget';
  readonly stopReason: string | null;
  readonly outOfScope: number;
}
const SUCCEEDED: RunOutcome = { status: 'succeeded', stopReason: null, outOfScope: 0 };

describeWorkflow(
  'C06 session 2a: the handoff to the runner on Temporal',
  () => {
    let db: TestDatabase;
    let t: Harness;
    let env: TestWorkflowEnvironment;
    let bundlePath: string;
    let signals: TemporalIntentSignals;
    let intentWorker: IntentWorkerHandle | undefined;
    let runnerWorker: Worker | undefined;
    let runnerRunning: Promise<void> | undefined;
    let mode: Mode = 'succeed';
    let active = 0;
    let maxActive = 0;
    /** In `expire_once`: the first run the runner sees has an expired contract. */
    let expireNext = false;
    /** The next runs' outcomes per intent (FIFO); then `SUCCEEDED`. */
    const outcomes = new Map<string, RunOutcome[]>();

    /** The fake runner: claims the run, keeps it for a moment, ends it (or never answers). */
    async function executeRun(input: ExecuteRunInput): Promise<ExecuteRunResult> {
      const scope = t.f.scope;
      if (mode === 'expire_once' && expireNext) {
        expireNext = false;
        // The run waited too long: its contract expired before this runner took it.
        t.setClock(new Date(T0.getTime() + 16 * MINUTE));
        return { outcome: 'refused', reason: 'expired' };
      }
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        const now = new Date();
        await scope.runs.claimForProvisioning(input.runId, now);
        await scope.runs.transition(input.runId, { from: ['provisioning'], to: 'running', now });
        if (mode === 'lost') {
          // The runner is gone: no heartbeat, no answer, until Temporal gives up on it.
          await new Promise((resolve) =>
            Context.current().cancellationSignal.addEventListener('abort', resolve),
          );
          return { outcome: 'refused', reason: 'cancelled' };
        }
        Context.current().heartbeat();
        await new Promise((resolve) => setTimeout(resolve, 300));
        const run = await scope.runs.getById(input.runId);
        const end = outcomes.get(run!.intent_id)?.shift() ?? SUCCEEDED;
        // What the runner records about the changes (C07 PR 1): hashes and counts only.
        await scope.runEvents.append(input.runId, 'diff_stored', {
          sha256: 'd'.repeat(64),
          size_bytes: 64,
          changed_files: 1,
        });
        await scope.runEvents.append(input.runId, 'changes_checked', {
          changed_files: 1,
          out_of_scope: end.outOfScope,
          instruction_files: 0,
          paths_sha256: 'a'.repeat(64),
        });
        await scope.runs.transition(input.runId, {
          from: ['running'],
          to: end.status,
          now: new Date(),
          ...(end.stopReason === null ? {} : { stopReason: end.stopReason }),
          finishedAt: new Date(),
        });
        return { outcome: 'ended', status: end.status, stopReason: end.stopReason };
      } finally {
        active -= 1;
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

    beforeAll(async () => {
      db = await createTestDatabase();
      t = await harness(db);
      env = await TestWorkflowEnvironment.createTimeSkipping({
        server: { executable: { type: 'existing-path', path: testServer! } },
      });
      const { code } = await bundleWorkflowCode({ workflowsPath: WORKFLOWS });
      bundlePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-run-')), 'bundle.js');
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
      // One slot, like `SDLC_RUNNER_MAX_SANDBOXES=1`: extra runs wait in Temporal.
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

    it('G4 → running → the runner → G5 (HOTL pass) → G6, end to end; one slot: the second run waits', async () => {
      mode = 'succeed';
      t.setClock(T0);
      const first = await atG4(t, 'medium');
      const second = await atG4(t, 'medium');
      await Promise.all([signals.wake(ref(first)), signals.wake(ref(second))]);
      await until(first, 'in_gate', 'G6');
      await until(second, 'in_gate', 'G6');
      expect(maxActive).toBe(1);
      for (const intent of [first, second]) {
        const [run] = await t.f.scope.runs.listForIntent(intent.id);
        expect(run).toMatchObject({ status: 'succeeded' });
        // The key was revoked by run: no key ID ever went through the workflow.
        expect(t.calls.revoked).toContain(run!.id);
        const kinds = (await t.f.scope.intentNotices.listForIntent(intent.id)).map((n) => n.kind);
        expect(kinds.slice(-3)).toEqual(['run_started', 'run_finished', 'hotl_passed']);
      }

      // The history replays on the current code; it holds no key ID and no raw secret.
      const handle = env.client.workflow.getHandle(intentWorkflowId(ref(first)));
      const history = await handle.fetchHistory();
      // Payloads are stored as bytes: decode them before looking for secrets.
      const text = JSON.stringify(history, (key, value: unknown) => {
        if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
        return key === 'data' && typeof value === 'string'
          ? Buffer.from(value, 'base64').toString('utf8')
          : value;
      });
      expect(text).toContain('wrap-token'); // the single-use wrapping token is there, by design
      expect(text).not.toContain('sk-virtual');
      expect(text).not.toContain('ghs_token');
      expect(text).not.toContain('key-');
      await expect(
        Worker.runReplayHistory({ workflowBundle: { codePath: bundlePath } }, history),
      ).resolves.toBeUndefined();
    });

    it('a contract that expired while its run waited: cancelled, then a new attempt', async () => {
      mode = 'expire_once';
      expireNext = true;
      t.setClock(T0);
      const intent = await atG4(t, 'medium');
      await signals.wake(ref(intent));
      await until(intent, 'in_gate', 'G6');
      expect(
        (await t.f.scope.runs.listForIntent(intent.id)).map((r) => [r.status, r.stop_reason]),
      ).toEqual([
        ['cancelled', 'contract_expired'],
        ['succeeded', null],
      ]);
    });

    it('N1: changes outside the plan → G5 fails → back to G3 (HITL, a new plan needed)', async () => {
      mode = 'succeed';
      t.setClock(T0);
      const intent = await atG4(t, 'medium');
      outcomes.set(intent.id, [{ status: 'succeeded', stopReason: null, outOfScope: 2 }]);
      await signals.wake(ref(intent));
      // `atG4` leaves the intent at G3 before the workflow moves it: wait for the G5 decision.
      const g5 = await waitFor(
        () => t.f.scope.gateDecisions.listForIntent(intent.id, 'G5'),
        (decisions) => decisions.length > 0,
      );
      expect(g5.map((d) => [d.decision, d.reason_code])).toEqual([['fail', 'out_of_scope']]);
      await until(intent, 'in_gate', 'G3');
      expect(await t.f.scope.escalations.listForIntent(intent.id)).toEqual([]);
    });

    it('N3: the cost cap → paused at G5 with an escalation; resume with more budget → a new run with the new cap → G6', async () => {
      mode = 'succeed';
      t.setClock(T0);
      const intent = await atG4(t, 'medium');
      outcomes.set(intent.id, [
        { status: 'stopped_budget', stopReason: 'max_budget', outOfScope: 0 },
      ]);
      await signals.wake(ref(intent));
      await until(intent, 'paused', 'G5');
      const [escalation] = await t.f.scope.escalations.listForIntent(intent.id);
      expect(escalation).toMatchObject({
        route: 'intent',
        response_level: 'pause',
        packet: { gate: 'G5', reason_code: 'budget_exceeded', subject_kind: 'g5_input' },
      });

      // Person A decides through the API path: resume, with a budget increase named.
      const deps = { now: () => t.f.registry.now() };
      await acknowledgeEscalation(
        t.f.scope,
        { escalationId: escalation!.id, actorId: t.f.users.a },
        deps,
      );
      await decideEscalation(
        t.f.scope,
        {
          escalationId: escalation!.id,
          actorId: t.f.users.a,
          decision: 'resume',
          actions: ['run_start', 'budget_increase'],
          budgetIncreaseUsd: '1.5',
        },
        deps,
      );
      await signals.wake(ref(intent));
      await until(intent, 'in_gate', 'G6');
      const runs = await t.f.scope.runs.listForIntent(intent.id);
      expect(runs.map((r) => [r.status, r.stop_reason])).toEqual([
        ['stopped_budget', 'max_budget'],
        ['succeeded', null],
      ]);
      const contract = await t.f.scope.runContracts.getByRunId(runs[1]!.id);
      expect(contract?.contract_json).toMatchObject({ max_budget_usd: '3.5' });
      expect((await reload(intent)).run_budget_usd).toBe('3.500000');

      const history = await env.client.workflow
        .getHandle(intentWorkflowId(ref(intent)))
        .fetchHistory();
      await expect(
        Worker.runReplayHistory({ workflowBundle: { codePath: bundlePath } }, history),
      ).resolves.toBeUndefined();
    });

    it('a lost runner: the key is revoked at once, the run fails, the intent is paused and escalated', async () => {
      mode = 'lost';
      t.setClock(T0);
      const intent = await atG4(t, 'medium');
      await signals.wake(ref(intent));
      const [run] = await waitFor(
        () => t.f.scope.runs.listForIntent(intent.id),
        (runs) => runs[0]?.status === 'running',
      );
      // The heartbeat timeout (2 minutes) passes without a heartbeat.
      await env.sleep(3 * MINUTE);
      await until(intent, 'paused', 'G4');
      expect(await t.f.scope.runs.getById(run!.id)).toMatchObject({
        status: 'failed',
        stop_reason: 'runner_lost',
      });
      expect(t.calls.revoked).toContain(run!.id);
      const [escalation] = await t.f.scope.escalations.listForIntent(intent.id);
      expect(escalation).toMatchObject({
        run_id: run!.id,
        route: 'technical',
        response_level: 'pause',
      });
      mode = 'succeed';
    });
  },
  120_000,
);
