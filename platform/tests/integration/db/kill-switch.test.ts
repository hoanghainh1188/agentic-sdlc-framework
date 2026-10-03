// D-08 C11 AC1–AC2 on a live PostgreSQL, without Temporal (D-02 FR-34, D-03 §6.5, design/ADR-M42):
// - who may kill: config `access.kill_roles` (Person A, Person B, governance; the producer too);
//   the viewer and people without a role on the project never;
// - a queued run ends `stopped_killed` at once; a run a runner holds goes to `stopping`; a second
//   kill changes nothing; a run that ended otherwise is refused;
// - the kill raises its escalation at once (technical, `run.kill_escalation`), records the run
//   event, the audit event (IDs only) and the status notice; the intent is then paused at G4,
//   `resume` starts a new round, `terminate` closes it;
// - a lost runner ends a `stopping` run `stopped_killed`; the worker revokes the key of a killed
//   run at once; the database keeps a kill a kill (migration 0020);
// - `/kill` on the issue: a person with a kill role stops the run; an account that is not linked
//   (the pilot repository is public) or a role without the kill switch is answered, and nothing
//   is stopped;
// - a wrapping token someone else opened sends the failed run's escalation to security.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { IntentWorkflowRef } from '../../../packages/contracts/src/intent-workflow.js';
import { DbError } from '../../../packages/core/src/db/errors.js';
import type { Intent } from '../../../packages/core/src/db/schema.js';
import {
  acknowledgeEscalation,
  decideEscalation,
} from '../../../packages/core/src/escalation/decide.js';
import {
  KillError,
  requestRunKill,
  revokeKilledRunKey,
  type KillActor,
} from '../../../packages/core/src/kill/index.js';
import {
  abandonRun,
  finishRun,
  startRun,
} from '../../../packages/core/src/workflow/run-lifecycle.js';
import { atG4, BASE_1, harness, MODEL, notices, T0, type Harness } from '../g4-harness.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

describeDb('C11: the kill switch on PostgreSQL', () => {
  let db: TestDatabase;
  let t: Harness;
  let viewer: string;
  let pm: string;
  let outsider: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    t = await harness(db);
    const scope = t.f.scope;
    const make = async (name: string, role?: 'viewer' | 'pm_brse') => {
      const user = await scope.users.create({ display_name: name, email: `${name}@example.com` });
      if (role) {
        await scope.roleBindings.grant({
          user_id: user.id,
          project_id: t.f.target.projectId,
          role,
        });
      }
      return user.id;
    };
    viewer = await make('vic', 'viewer');
    pm = await make('pam', 'pm_brse');
    outsider = await make('oscar');
    await scope.userIdentities.link({
      user_id: viewer,
      provider: 'github',
      external_id: '3009',
      external_login: 'vic',
    });
  }, 60_000);

  afterAll(async () => {
    await t?.f.close();
    await db?.drop();
  });

  beforeEach(async () => {
    t.setClock(T0);
    Object.assign(t.world, { base: BASE_1, models: [MODEL], gitDown: false, tenantBudget: null });
    t.calls.revoked.length = 0;
    await t.setConfig(`run:\n  agent_key: ${t.agent.key}\n`);
  });

  const scope = () => t.f.scope;
  const reload = (intent: Intent) => t.reload(intent);
  const human = (id: string): KillActor => ({ type: 'human', id });
  const kill = (runId: string, actor: KillActor = human(t.f.users.b)) =>
    requestRunKill(scope(), { now: () => T0 }, { runId, actor, source: 'api' });

  /** A Medium intent `running` with a queued run (a runner has not taken it). */
  async function queuedRun(): Promise<{ intent: Intent; runId: string }> {
    const intent = await atG4(t, 'medium');
    expect(await t.settleRuns(intent)).toEqual({ outcome: 'run_prepare' });
    const started = await startRun(scope(), t.runDeps, intent.id);
    if (!started.ok) throw new Error('not started');
    return { intent, runId: started.run.runId };
  }

  /** The same with the run `running` (a runner took it). */
  async function runningRun(): Promise<{ intent: Intent; runId: string }> {
    const queued = await queuedRun();
    const now = new Date();
    await scope().runs.claimForProvisioning(queued.runId, now);
    await scope().runs.transition(queued.runId, { from: ['provisioning'], to: 'running', now });
    return queued;
  }

  describe('who may kill (AC1)', () => {
    it('Person A (the producer), Person B and governance may; viewer and people without a role may not', async () => {
      for (const who of ['a', 'b', 'gov'] as const) {
        const { runId } = await queuedRun();
        expect((await kill(runId, human(t.f.users[who]))).status).toBe('stopped_killed');
      }
      const { runId } = await queuedRun();
      await expect(kill(runId, human(viewer))).rejects.toMatchObject({ code: 'forbidden' });
      await expect(kill(runId, human(pm))).rejects.toMatchObject({ code: 'forbidden' });
      // No role on the project: as if the run did not exist.
      await expect(kill(runId, human(outsider))).rejects.toMatchObject({ code: 'run_not_found' });
      await expect(kill('00000000-0000-4000-8000-000000000000')).rejects.toBeInstanceOf(KillError);
      expect((await scope().runs.getById(runId))?.status).toBe('queued');
    });

    it('config may add roles (access.kill_roles), never remove FR-34’s', async () => {
      await t.setConfig(
        `run:\n  agent_key: ${t.agent.key}\naccess:\n  kill_roles: [person_a, person_b, governance, pm_brse]\n`,
      );
      const { runId } = await queuedRun();
      expect((await kill(runId, human(pm))).status).toBe('stopped_killed');
    });
  });

  describe('what a kill records (AC2)', () => {
    it('a queued run ends stopped_killed at once; escalation, event, audit, notice; a second kill changes nothing', async () => {
      const { intent, runId } = await queuedRun();
      const result = await kill(runId);
      expect(result).toMatchObject({
        runId,
        intentId: intent.id,
        status: 'stopped_killed',
        already: false,
      });
      expect(await scope().runs.getById(runId)).toMatchObject({
        status: 'stopped_killed',
        stop_reason: 'killed',
        killed_by: t.f.users.b,
      });
      // The runner can no longer take it.
      expect(await scope().runs.claimForProvisioning(runId, new Date())).toBe(false);

      const [escalation, ...more] = await scope().escalations.listForIntent(intent.id);
      expect(more).toEqual([]);
      expect(escalation).toMatchObject({
        id: result.escalationId,
        run_id: runId,
        trigger: 'risky_action',
        route: 'technical',
        severity: 'high',
        response_level: 'contain',
      });
      expect(escalation!.packet).toMatchObject({
        subject_kind: 'run_contract',
        gate: 'G4',
        run_id: runId,
      });
      const events = await scope().runEvents.list(runId);
      expect(events.map((e) => [e.event_type, e.payload])).toContainEqual([
        'kill_requested',
        { previous_status: 'queued', source: 'api' },
      ]);
      const audit = await scope().audit.listForEntity(runId, ['run.kill_requested']);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actor_type: 'human', actor_id: t.f.users.b });
      expect(audit[0]!.payload).toEqual({
        intent_id: intent.id,
        previous_status: 'queued',
        source: 'api',
        escalation_id: result.escalationId,
      });
      expect(await notices(t, intent)).toContain('run_killed');

      // Again: nothing new.
      expect(await kill(runId, human(t.f.users.a))).toMatchObject({
        status: 'stopped_killed',
        already: true,
      });
      expect(await scope().escalations.listForIntent(intent.id)).toHaveLength(1);
      expect(await scope().audit.listForEntity(runId, ['run.kill_requested'])).toHaveLength(1);
      expect((await scope().runs.getById(runId))?.killed_by).toBe(t.f.users.b);
    });

    it('a running run goes to stopping; the step waits; a lost runner ends it stopped_killed', async () => {
      const { intent, runId } = await runningRun();
      expect((await kill(runId)).status).toBe('stopping');
      expect(await kill(runId)).toMatchObject({ status: 'stopping', already: true });
      expect(await t.settleRuns(intent)).toEqual({ outcome: 'waiting', reason: 'run_in_progress' });
      // The workflow got the kill signal: the worker revokes the key at once.
      expect(await revokeKilledRunKey(scope(), t.runDeps, runId)).toBe(true);
      expect(t.calls.revoked).toEqual([runId]);
      // The runner's heartbeat is lost.
      await abandonRun(scope(), t.runDeps, runId);
      expect(await scope().runs.getById(runId)).toMatchObject({
        status: 'stopped_killed',
        stop_reason: 'killed',
        killed_by: t.f.users.b,
      });
      expect(await t.settleRuns(intent)).toEqual({ outcome: 'run_ended', runId });
    });

    it('a run that ended otherwise is refused; the worker revokes nothing for it', async () => {
      const { runId } = await runningRun();
      const now = new Date();
      await scope().runs.transition(runId, { from: ['running'], to: 'succeeded', now });
      await expect(kill(runId)).rejects.toMatchObject({ code: 'run_not_active' });
      expect(await revokeKilledRunKey(scope(), t.runDeps, runId)).toBe(false);
      expect(t.calls.revoked).toEqual([]);
    });

    it('the operator kills as the system: no killed_by, audit actor system', async () => {
      const { runId } = await runningRun();
      await requestRunKill(scope(), {}, { runId, actor: { type: 'system' }, source: 'ops' });
      expect(await scope().runs.getById(runId)).toMatchObject({
        status: 'stopping',
        killed_by: null,
      });
      const [audit] = await scope().audit.listForEntity(runId, ['run.kill_requested']);
      expect(audit).toMatchObject({ actor_type: 'system', actor_id: null });
    });

    it('runs.end: one update ends a run, or ends it killed when it is stopping (no lost kill)', async () => {
      const { runId } = await runningRun();
      await kill(runId);
      // A writer that read `running` before the kill ends the run as it planned: the kill wins.
      expect(
        await scope().runs.end(runId, {
          from: ['running'],
          to: 'succeeded',
          now: new Date(),
          finishedAt: new Date(),
        }),
      ).toBe('stopped_killed');
      expect(await scope().runs.getById(runId)).toMatchObject({
        status: 'stopped_killed',
        stop_reason: 'killed',
        killed_by: t.f.users.b,
      });
      // Already final: nothing changes.
      expect(
        await scope().runs.end(runId, { from: ['running'], to: 'failed', now: new Date() }),
      ).toBeUndefined();
      const other = await runningRun();
      expect(
        await scope().runs.end(other.runId, {
          from: ['running'],
          to: 'failed',
          now: new Date(),
          stopReason: 'agent_error',
        }),
      ).toBe('failed');
      expect(await scope().runs.getById(other.runId)).toMatchObject({ stop_reason: 'agent_error' });
    });

    it('the database keeps a kill a kill (migration 0020)', async () => {
      const { runId } = await runningRun();
      await kill(runId);
      const now = new Date();
      // A stopping run never ends otherwise; killed_by never changes.
      await expect(
        scope().runs.transition(runId, { from: ['stopping'], to: 'failed', now, stopReason: 'x' }),
      ).rejects.toMatchObject({ code: 'immutable' });
      await expect(
        scope().runs.transition(runId, {
          from: ['stopping'],
          to: 'stopping',
          now,
          killedBy: t.f.users.a,
        }),
      ).rejects.toMatchObject({ code: 'immutable' });
      // A killed run has the stop reason `killed`.
      await expect(
        scope().runs.transition(runId, {
          from: ['stopping'],
          to: 'stopped_killed',
          now,
          stopReason: 'agent_error',
        }),
      ).rejects.toBeInstanceOf(DbError);
      // killed_by only on stopping or stopped_killed runs.
      const other = await runningRun();
      await expect(
        scope().runs.transition(other.runId, {
          from: ['running'],
          to: 'running',
          now,
          killedBy: t.f.users.a,
        }),
      ).rejects.toMatchObject({ code: 'invalid_value' });
    });
  });

  describe('how the intent continues (D-03 "Stopped → Escalated")', () => {
    async function killedAndPaused() {
      const { intent, runId } = await runningRun();
      const { escalationId } = await kill(runId);
      await abandonRun(scope(), t.runDeps, runId);
      await finishRun(scope(), t.runDeps, intent.id, runId);
      expect(await reload(intent)).toMatchObject({ status: 'paused', current_gate: 'G4' });
      expect(await t.settleRuns(intent)).toEqual({ outcome: 'waiting', reason: 'run_review' });
      // Person B (technical route) acknowledges.
      await acknowledgeEscalation(scope(), { escalationId: escalationId!, actorId: t.f.users.b });
      return { intent, runId, escalationId: escalationId! };
    }

    it('resume → back to G4 and a new round', async () => {
      const { intent, escalationId } = await killedAndPaused();
      await decideEscalation(scope(), { escalationId, actorId: t.f.users.b, decision: 'resume' });
      expect(await t.settleRuns(intent)).toEqual({ outcome: 'run_prepare' });
      expect(await notices(t, intent)).toContain('run_resumed');
      expect((await scope().escalations.getById(escalationId))?.status).toBe('closed');
    });

    it('terminate → the intent is closed (cancelled)', async () => {
      const { intent, escalationId } = await killedAndPaused();
      await decideEscalation(scope(), {
        escalationId,
        actorId: t.f.users.b,
        decision: 'terminate',
      });
      expect(await t.settleRuns(intent)).toMatchObject({
        outcome: 'finished',
        status: 'cancelled',
      });
      expect(await reload(intent)).toMatchObject({ status: 'cancelled' });
      expect((await scope().escalations.getById(escalationId))?.status).toBe('closed');
      const [last] = (await scope().intentNotices.listForIntent(intent.id)).slice(-1);
      expect(last).toMatchObject({ kind: 'terminated', gate: 'G4', status: 'cancelled' });
    });

    it('the reconcile list holds the intent while its current run is being killed, not after', async () => {
      const { intent, runId } = await runningRun();
      const listed = async () =>
        (await db.app.system.listKillingIntents(100)).map((r) => r.intentId);
      expect(await listed()).not.toContain(intent.id);
      await kill(runId);
      expect(await listed()).toContain(intent.id);
      await abandonRun(scope(), t.runDeps, runId);
      expect(await listed()).toContain(intent.id);
      await finishRun(scope(), t.runDeps, intent.id, runId);
      expect(await listed()).not.toContain(intent.id);
    });
  });

  describe('/kill on the issue (AC1)', () => {
    function signals() {
      const sent: string[] = [];
      return {
        sent,
        wake: (ref: IntentWorkflowRef) => {
          sent.push(`wake:${ref.intentId}`);
          return Promise.resolve();
        },
        kill: (ref: IntentWorkflowRef) => {
          sent.push(`kill:${ref.intentId}`);
          return Promise.resolve();
        },
      };
    }

    it('Person B stops the current run; the poller sends kill, then wake', async () => {
      const { intent, runId } = await runningRun();
      t.f.comment(intent, '/kill the agent loops on npm install', 'b');
      const s = signals();
      const result = await t.f.poll(s);
      expect(result.outcomes).toMatchObject({ killed: 1 });
      expect(await scope().runs.getById(runId)).toMatchObject({
        status: 'stopping',
        killed_by: t.f.users.b,
      });
      expect(s.sent).toEqual([`kill:${intent.id}`, `wake:${intent.id}`]);
      const [audit] = await scope().audit.listForEntity(runId, ['run.kill_requested']);
      expect(audit?.payload).toMatchObject({ source: 'github_comment' });
      // No reply: the status comment `run_killed` confirms it.
      expect(t.f.posted(intent).join('\n')).not.toMatch(/Not stopped/);
    });

    it('an account that is not linked (the pilot repository is public) stops nothing', async () => {
      const { intent, runId } = await runningRun();
      t.f.comment(intent, '/kill', { gh: 99_001, login: 'drive-by' });
      const s = signals();
      const result = await t.f.poll(s);
      expect(result.outcomes).toMatchObject({ user_not_linked: 1 });
      expect((await scope().runs.getById(runId))?.status).toBe('running');
      expect(s.sent.filter((x) => x.startsWith('kill:'))).toEqual([]);
      expect(await scope().audit.listForEntity(runId, ['run.kill_requested'])).toEqual([]);
    });

    it('a linked viewer is refused with a reply; nothing is stopped', async () => {
      const { intent, runId } = await runningRun();
      t.f.comment(intent, '/kill', { gh: 3009, login: 'vic' });
      const result = await t.f.poll(signals());
      expect(result.outcomes).toMatchObject({ refused: 1 });
      expect((await scope().runs.getById(runId))?.status).toBe('running');
    });

    it('no run to stop: a reply says so', async () => {
      const { intent, runId } = await runningRun();
      await scope().runs.transition(runId, { from: ['running'], to: 'succeeded', now: new Date() });
      t.f.comment(intent, '/kill', 'a');
      const result = await t.f.poll(signals());
      expect(result.outcomes).toMatchObject({ refused: 1 });
    });
  });

  it('a wrapping token someone else opened sends the failed run to the security route', async () => {
    const { intent, runId } = await runningRun();
    await scope().runEvents.append(runId, 'wrap_token_reused', { token: 'virtual_key' });
    await scope().runs.transition(runId, {
      from: ['running'],
      to: 'failed',
      now: new Date(),
      stopReason: 'key_unavailable',
      finishedAt: new Date(),
    });
    await finishRun(scope(), t.runDeps, intent.id, runId);
    const [escalation] = await scope().escalations.listForIntent(intent.id);
    expect(escalation).toMatchObject({ route: 'security', run_id: runId });
  });
});
