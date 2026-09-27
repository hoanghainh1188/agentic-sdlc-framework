// D-08 C06 session 2a on a live PostgreSQL, without Temporal (design/ADR-M33 §2.6–§2.7):
// - a decided G4 moves the intent to `running` and asks for a run (`run_prepare`); `startRun`
//   prepares one; a second call never issues a second run (`run_exists`);
// - a freeze that comes while the contract is signed cancels the run before any secret;
// - the run's end moves the intent: to G5 (`succeeded`, a cap), `paused` + a technical escalation
//   (`failed`, a lost runner, contracts that kept expiring), `paused` (`stopped_killed`), back to
//   G4 (a refused start); the key is revoked by run, at once for a lost runner;
// - a paused intent goes back to G4 once a person decides `resume` on the run's escalation;
// - an L1 (High risk) intent does not start a run in session 2a.
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import { CostError } from '../../../packages/core/src/cost/errors.js';
import type { Intent } from '../../../packages/core/src/db/schema.js';
import {
  acknowledgeEscalation,
  decideEscalation,
} from '../../../packages/core/src/escalation/decide.js';
import {
  abandonRun,
  finishRun,
  startRun,
} from '../../../packages/core/src/workflow/run-lifecycle.js';
import { atG4, BASE_1, harness, MODEL, notices, T0, type Harness } from '../g4-harness.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

const MINUTE = 60_000;

describeDb('C06 session 2a: the run after G4 on PostgreSQL', () => {
  let db: TestDatabase;
  let t: Harness;

  beforeAll(async () => {
    db = await createTestDatabase();
    t = await harness(db);
  }, 60_000);

  afterAll(async () => {
    await t?.f.close();
    await db?.drop();
  });

  beforeEach(async () => {
    t.setClock(T0);
    Object.assign(t.world, { base: BASE_1, models: [MODEL], gitDown: false, tenantBudget: null });
    t.calls.keys.length = 0;
    t.calls.revoked.length = 0;
    t.calls.wrapped.length = 0;
    t.calls.refuseKey = undefined;
    await t.setConfig(`run:\n  agent_key: ${t.agent.key}\n`);
  });

  const reload = (intent: Intent) => t.reload(intent);
  const runs = (intent: Intent) => t.f.scope.runs.listForIntent(intent.id);

  /** A Medium intent at `running` with no run yet. */
  async function running(): Promise<Intent> {
    const intent = await atG4(t, 'medium');
    expect(await t.settleRuns(intent)).toEqual({ outcome: 'run_prepare' });
    expect(await reload(intent)).toMatchObject({ status: 'running', current_gate: 'G4' });
    return intent;
  }

  /** What the runner does to a run (the test plays the runner). */
  async function runnerEnds(
    runId: string,
    to: 'succeeded' | 'failed' | 'stopped_killed' | 'stopped_budget',
  ) {
    const now = new Date();
    await t.f.scope.runs.claimForProvisioning(runId, now);
    await t.f.scope.runs.transition(runId, { from: ['provisioning'], to: 'running', now });
    await t.f.scope.runs.transition(runId, {
      from: ['running'],
      to,
      now,
      ...(to === 'succeeded'
        ? {}
        : { stopReason: to === 'failed' ? 'agent_error' : 'max_iterations' }),
      finishedAt: now,
    });
  }

  it('G4 decided → running → one run; a second start is refused (run_exists)', async () => {
    const intent = await running();
    expect(await notices(t, intent)).toContain('run_started');

    const first = await startRun(t.f.scope, t.runDeps, intent.id);
    expect(first.ok).toBe(true);
    expect(await startRun(t.f.scope, t.runDeps, intent.id)).toEqual({
      ok: false,
      reason: 'run_exists',
    });
    expect((await runs(intent)).map((r) => r.status)).toEqual(['queued']);
    expect(t.calls.keys).toHaveLength(1);
    // The run is under way: the step waits.
    expect(await t.settleRuns(intent)).toEqual({ outcome: 'waiting', reason: 'run_in_progress' });
    expect(await reload(intent)).toMatchObject({ status: 'running' });
  });

  it('a succeeded run: the key is revoked by run and the intent waits at G5', async () => {
    const intent = await running();
    const started = await startRun(t.f.scope, t.runDeps, intent.id);
    if (!started.ok) throw new Error('not started');
    await runnerEnds(started.run.runId, 'succeeded');
    expect(await t.settleRuns(intent)).toEqual({
      outcome: 'run_ended',
      runId: started.run.runId,
    });
    await finishRun(t.f.scope, t.runDeps, intent.id, started.run.runId);
    expect(t.calls.revoked).toEqual([started.run.runId]);
    expect(await reload(intent)).toMatchObject({ status: 'in_gate', current_gate: 'G5' });
    expect(await notices(t, intent)).toContain('run_finished');
    // Finishing again changes nothing.
    await finishRun(t.f.scope, t.runDeps, intent.id, started.run.runId);
    expect(await reload(intent)).toMatchObject({ status: 'in_gate', current_gate: 'G5' });
  });

  it('a stop at a cap goes to G5 too (C07 decides; QUESTIONS #21, #82)', async () => {
    const intent = await running();
    const started = await startRun(t.f.scope, t.runDeps, intent.id);
    if (!started.ok) throw new Error('not started');
    await runnerEnds(started.run.runId, 'stopped_budget');
    await finishRun(t.f.scope, t.runDeps, intent.id, started.run.runId);
    expect(await reload(intent)).toMatchObject({ status: 'in_gate', current_gate: 'G5' });
  });

  it('a lost runner: the key is revoked at once, the run fails, the intent is paused and escalated; resume after a decision', async () => {
    const intent = await running();
    const started = await startRun(t.f.scope, t.runDeps, intent.id);
    if (!started.ok) throw new Error('not started');
    const runId = started.run.runId;
    await t.f.scope.runs.claimForProvisioning(runId, new Date());

    await abandonRun(t.f.scope, t.runDeps, runId);
    expect(t.calls.revoked).toEqual([runId]);
    expect((await t.f.scope.runs.getById(runId))!).toMatchObject({
      status: 'failed',
      stop_reason: 'runner_lost',
    });
    const events = await t.f.scope.runEvents.list(runId);
    expect(events.map((e) => [e.event_type, e.payload])).toContainEqual([
      'run_abandoned',
      { previous_status: 'provisioning' },
    ]);

    expect(await t.settleRuns(intent)).toEqual({ outcome: 'run_ended', runId });
    await finishRun(t.f.scope, t.runDeps, intent.id, runId);
    expect(await reload(intent)).toMatchObject({ status: 'paused', current_gate: 'G4' });
    const [escalation] = await t.f.scope.escalations.listForIntent(intent.id);
    expect(escalation).toMatchObject({
      run_id: runId,
      route: 'technical',
      response_level: 'pause',
      severity: 'high',
      trigger: 'unusual_behaviour',
    });
    expect(await t.settleRuns(intent)).toEqual({ outcome: 'waiting', reason: 'run_review' });

    // Person B (technical route) acknowledges and decides `resume` for this run's contract.
    await acknowledgeEscalation(t.f.scope, { escalationId: escalation!.id, actorId: t.f.users.b });
    await decideEscalation(t.f.scope, {
      escalationId: escalation!.id,
      actorId: t.f.users.b,
      decision: 'resume',
    });
    // Back at G4, decided again by POLICY, and running with a new round.
    expect(await t.settleRuns(intent)).toEqual({ outcome: 'run_prepare' });
    expect(await notices(t, intent)).toContain('run_resumed');
    expect((await t.f.scope.escalations.getById(escalation!.id))?.status).toBe('closed');
    // The old failed run belongs to the earlier round: it is never finished again.
    const again = await startRun(t.f.scope, t.runDeps, intent.id);
    expect(again.ok).toBe(true);
  });

  it('a run killed (C11) pauses the intent without an escalation of its own', async () => {
    const intent = await running();
    const started = await startRun(t.f.scope, t.runDeps, intent.id);
    if (!started.ok) throw new Error('not started');
    await runnerEnds(started.run.runId, 'stopped_killed');
    await finishRun(t.f.scope, t.runDeps, intent.id, started.run.runId);
    expect(await reload(intent)).toMatchObject({ status: 'paused', current_gate: 'G4' });
    expect(await t.f.scope.escalations.listForIntent(intent.id)).toEqual([]);
    expect(await t.settleRuns(intent)).toEqual({ outcome: 'waiting', reason: 'run_review' });
  });

  it('contracts that expire before a runner takes them: new attempts, then an escalation', async () => {
    const intent = await running();
    let clock = T0.getTime();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const started = await startRun(t.f.scope, t.runDeps, intent.id);
      expect(started.ok).toBe(true);
      clock += 16 * MINUTE;
      t.setClock(new Date(clock));
      const next = await t.settleRuns(intent);
      if (attempt < 3) expect(next).toEqual({ outcome: 'run_prepare' });
      else expect(next).toMatchObject({ outcome: 'run_ended' });
    }
    expect((await runs(intent)).map((r) => [r.status, r.stop_reason])).toEqual([
      ['cancelled', 'contract_expired'],
      ['cancelled', 'contract_expired'],
      ['cancelled', 'contract_expired'],
    ]);
    const last = (await runs(intent)).at(-1)!;
    await finishRun(t.f.scope, t.runDeps, intent.id, last.id);
    expect(await reload(intent)).toMatchObject({ status: 'paused' });
    expect(await t.f.scope.escalations.listForIntent(intent.id)).toHaveLength(1);
  });

  it('a used-up budget: the run is cancelled and the intent goes back to G4', async () => {
    const intent = await running();
    t.calls.refuseKey = new CostError('intent_budget_exhausted', 'used up');
    expect(await startRun(t.f.scope, t.runDeps, intent.id)).toEqual({
      ok: false,
      reason: 'budget_exceeded',
    });
    expect(await reload(intent)).toMatchObject({ status: 'in_gate', current_gate: 'G4' });
    expect(await notices(t, intent)).toContain('run_not_started');
  });

  it('a block of G4 while the contract is signed cancels the run before any secret', async () => {
    const intent = await running();
    const deps = {
      ...t.runDeps,
      signer: {
        sign: async (payload: Uint8Array) => {
          // An escalation freezes the intent while the contract is being signed.
          const { raiseEscalation } =
            await import('../../../packages/core/src/escalation/raise.js');
          await raiseEscalation(
            t.f.scope,
            {
              intentId: intent.id,
              trigger: 'uncertainty',
              route: 'technical',
              severity: 'high',
              responseLevel: 'pause',
              packet: { subject_kind: 'intent', subject_sha256: 'a'.repeat(64) },
              producers: [],
              raisedBy: { type: 'system' },
            },
            { now: () => T0 },
          );
          return t.runDeps.signer.sign(payload);
        },
      },
    };
    expect(await startRun(t.f.scope, deps, intent.id)).toEqual({
      ok: false,
      reason: 'not_decided',
    });
    expect((await runs(intent)).map((r) => [r.status, r.stop_reason])).toEqual([
      ['cancelled', 'not_decided'],
    ]);
    expect(t.calls.keys).toEqual([]);
    expect(t.calls.wrapped).toEqual([]);
  });

  it('session 2a: an L1 (High risk) intent does not start a run; it waits at G4', async () => {
    const intent = await atG4(t, 'high');
    await t.settleRuns(intent);
    await t.decide(await reload(intent), 'approve', 'a');
    expect(await t.settleRuns(intent)).toEqual({
      outcome: 'waiting',
      reason: 'proposal_runs_unavailable',
    });
    expect(await reload(intent)).toMatchObject({ status: 'in_gate', current_gate: 'G4' });
    expect(await runs(intent)).toEqual([]);
  });
});
