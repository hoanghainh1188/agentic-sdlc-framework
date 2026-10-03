// Gate G6, part 1: the push and the pull request (task C08 PR 1, D-08 C08 AC1, D-02 §5,
// design/D-03 sections 4 and 6, ADR-M38 §2.1–§2.5, QUESTIONS #52, #134, #156).
//
// `stepG6` runs when the intent waits `in_gate G6` after G5 passed its run. In this order:
//   1. the G5 block window: while a person may still block G5 (HOTL, ADR-M34 §2.8), nothing is
//      pushed (`later_gate`, woken when the window closes);
//   2. the freeze check (`push`, then `open_pr`; ADR-M28 §2.4);
//   3. no push recorded for the run → `publish` / `push`: the workflow asks for a push token, the
//      runner applies the run's stored diff (the diff G5 checked) to a clone of the run's base and
//      pushes one commit to `agent/INT-…` (`publishRun`);
//   4. pushed, no pull request linked → `publish` / `open_pr`: the worker finds or opens the pull
//      request and links it to the intent (`finishPublish`);
//   5. linked → the intent waits for CI (`ci_pending`; C08 PR 2 reads the checks).
// The push stops, and the intent is paused at G6 with a `technical` escalation (QUESTIONS #156),
// when the runner refuses (`empty_diff`, `diff_mismatch`, `branch_moved`…) or after
// `MAX_PUBLISH_ATTEMPTS` failed attempts. Level: `run.failed_run_escalation` (rule M20: `pause` or
// higher). The run's `triggered_by` is a producer: never owner, backup or decider (FR-18).
//
// `stepPausedG6` acts on the decision of that escalation (handbook Ch.6 §6.6), re-checked just
// before acting (FR-17):
//   `resume` → back to `in_gate G4`: a new run, from the last pushed commit or the default branch
//     (QUESTIONS #134); after `branch_moved` a person first restores or deletes the branch;
//   `modify` or `roll_back` → back to `in_gate G3`, HITL from then on (as after G5);
//   `terminate` → the intent ends `cancelled`.
// An escalation closed without a decision is raised again: a paused intent always has one.
import { createHash } from 'node:crypto';

import type { IntentStepResult, IntentStatus, ProjectRole } from '@sdlc/contracts';

import type { IntentNoticeKind } from '../db/repositories/intent-notices.js';
import type { Escalation, Intent, Run } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { EscalationError } from '../escalation/errors.js';
import { assertActionAllowed } from '../escalation/freeze.js';
import { raiseEscalation } from '../escalation/raise.js';
import type { Registry } from '../registry/registry.js';
import { G4_OPERATOR_ROLES } from './g4.js';
import { close, g3Approvers, stillValid, type G5Policy } from './g5.js';
import { gatherG6Facts, type CiReading } from './g6-ci.js';
import { stepCi } from './g6-verify.js';
import { hotlBlockWindowOpenUntil } from './hotl.js';
import { latestRun, MAX_PUBLISH_ATTEMPTS, publishState } from './publish-state.js';

/** Packet reason codes of G6 escalations whose `resume` stays at G6 (C08 PR 2). */
const CI_RESUMES_AT_G6: readonly string[] = ['ci_failed', 'security_finding'];

/** Why G6 stopped before CI when the push failed too often (audit, escalation packet). */
export const PUBLISH_ATTEMPTS = 'publish_attempts';

type Waiting = Extract<IntentStepResult, { outcome: 'waiting' }>;
const moved: IntentStepResult = { outcome: 'moved' };
const wait = (reason: Waiting['reason'], wakeInMs?: number): IntentStepResult =>
  wakeInMs === undefined
    ? { outcome: 'waiting', reason }
    : { outcome: 'waiting', reason, wakeInMs };

/** The step at `in_gate G6` (see the header). Under the intent lock. */
export async function stepG6(
  tx: TenantScope,
  registry: Registry,
  policy: G5Policy,
  intent: Intent,
  /** C08 PR 2: what the step read from CI before the lock (null: nothing read). */
  ci: CiReading | null = null,
): Promise<IntentStepResult> {
  const run = await latestRun(tx, intent.id);
  // G5 passes only a run that succeeded (ADR-M29 §2.5); anything else is not for G6.
  if (run?.status !== 'succeeded') return wait('not_in_gate');

  const now = registry.now();
  const until = await hotlBlockWindowOpenUntil(tx, registry, intent.id, now);
  if (until !== null) return wait('later_gate', Math.max(0, until.getTime() - now.getTime()));

  const state = await publishState(tx, run.id);
  if (state.refused !== null) return stopPublish(tx, registry, policy, intent, run, state.refused);
  if (state.pushed === null) {
    if (state.failures >= MAX_PUBLISH_ATTEMPTS) {
      return stopPublish(tx, registry, policy, intent, run, PUBLISH_ATTEMPTS);
    }
    if (!(await allowed(tx, intent, 'push', now))) return wait('frozen');
    return { outcome: 'publish', runId: run.id, step: 'push' };
  }
  if (intent.pr_number === null) {
    // Failed attempts of the push and of the pull request count together.
    if (state.failures >= MAX_PUBLISH_ATTEMPTS) {
      return stopPublish(tx, registry, policy, intent, run, PUBLISH_ATTEMPTS);
    }
    if (!(await allowed(tx, intent, 'open_pr', now))) return wait('frozen');
    return { outcome: 'publish', runId: run.id, step: 'open_pr' };
  }
  // C08 PR 2: the pull request is linked; G6 reads CI (`g6-verify.ts`).
  return stepCi(tx, registry, policy, intent, ci);
}

/** Pauses the intent at G6 with a `technical` escalation (QUESTIONS #156). */
async function stopPublish(
  tx: TenantScope,
  registry: Registry,
  policy: G5Policy,
  intent: Intent,
  run: Run,
  reason: string,
): Promise<IntentStepResult> {
  const escalation = await raisePublishEscalation(tx, registry, policy, intent, run, reason);
  await tx.audit.append({
    action: 'gate.g6_publish_stopped',
    actorType: 'system',
    actorId: null,
    entityId: intent.id,
    occurredAt: registry.now(),
    payload: { run_id: run.id, reason, escalation_id: escalation.id },
  });
  return move(tx, registry, intent, { status: 'paused', gate: 'G6' }, 'g6_publish_stopped', [
    ...G4_OPERATOR_ROLES,
  ]);
}

/**
 * The escalation is bound to the run's checked diff (`diff_stored`): a decision applies to these
 * changes only. A run without one (never at G6: the runner fails such a run) binds to its ID.
 */
async function raisePublishEscalation(
  tx: TenantScope,
  registry: Registry,
  policy: G5Policy,
  intent: Intent,
  run: Run,
  reason: string,
): Promise<Escalation> {
  const state = await publishState(tx, run.id);
  const level = policy.config.run.failed_run_escalation;
  return raiseEscalation(
    tx,
    {
      intentId: intent.id,
      runId: run.id,
      trigger: 'unusual_behaviour',
      route: 'technical',
      severity: level.severity,
      responseLevel: level.response_level,
      packet: {
        subject_kind: 'diff',
        subject_sha256:
          state.diffSha256 ?? createHash('sha256').update(run.id, 'utf8').digest('hex'),
        gate: 'G6',
        run_id: run.id,
        agent_id: run.agent_id,
        reason_code: reason === PUBLISH_ATTEMPTS ? 'other' : 'input_mismatch',
      },
      // The person who allowed the run produced it with the agent (FR-11, FR-18).
      producers: run.triggered_by === null ? [] : [run.triggered_by],
      raisedBy: { type: 'system' },
    },
    { now: () => registry.now() },
  );
}

/** The step at `paused G6`: acts on the escalation's decision (see the header). Under the lock. */
export async function stepPausedG6(
  tx: TenantScope,
  registry: Registry,
  policy: G5Policy,
  intent: Intent,
): Promise<IntentStepResult> {
  const run = await latestRun(tx, intent.id);
  const escalation = run
    ? (await tx.escalations.listForIntent(intent.id))
        .filter((e) => e.run_id === run.id && e.packet.gate === 'G6' && e.trigger !== 'time')
        .at(-1)
    : undefined;
  if (!run || !escalation) return wait('publish_review');
  // C08 PR 2: an escalation at CI (bound to the G6 input) is decided on what G6 read. A changed
  // input voids its decision and closes it; an escalation closed without a decision acted on is
  // evaluated again. Either way G6 reads CI again (FR-17, as at G5).
  if (escalation.packet.subject_kind === 'g6_input') {
    const current = (await gatherG6Facts(tx, intent.id))?.inputSha256 ?? null;
    if (escalation.status === 'closed' || current !== escalation.packet.subject_sha256) {
      if (escalation.status !== 'closed') await close(tx, registry, escalation);
      return move(tx, registry, intent, { status: 'in_gate', gate: 'G6' }, 'g6_resumed', []);
    }
  }
  if (escalation.status === 'closed') {
    // Closed without a decision acted on: the refusal still holds, so a new escalation is raised.
    const state = await publishState(tx, run.id);
    await raisePublishEscalation(
      tx,
      registry,
      policy,
      intent,
      run,
      state.refused ?? PUBLISH_ATTEMPTS,
    );
    return wait('publish_review');
  }
  if (escalation.decision === null) return wait('publish_review');
  const subjectSha256 = String(escalation.packet.subject_sha256);

  switch (String(escalation.decision.decision)) {
    case 'resume': {
      if (!(await stillValid(tx, registry, escalation, subjectSha256, 'run_start'))) {
        return wait('publish_review');
      }
      await close(tx, registry, escalation);
      // C08 PR 2: after a CI timeout or a critical finding, `resume` means "go on at G6" (CI is
      // read again; a critical finding then waits for Person B's approval). Otherwise a new run.
      if (CI_RESUMES_AT_G6.includes(String(escalation.packet.reason_code))) {
        return move(tx, registry, intent, { status: 'in_gate', gate: 'G6' }, 'g6_resumed', [
          'person_b',
        ]);
      }
      return move(tx, registry, intent, { status: 'in_gate', gate: 'G4' }, 'run_resumed', [
        ...G4_OPERATOR_ROLES,
      ]);
    }
    case 'modify':
    case 'roll_back': {
      if (!(await stillValid(tx, registry, escalation, subjectSha256, 'gate_advance', true))) {
        return wait('publish_review');
      }
      await close(tx, registry, escalation);
      await registry.voidApprovals(tx, {
        intentId: intent.id,
        gate: 'G3',
        reasonCode: 'input_mismatch',
      });
      return move(
        tx,
        registry,
        intent,
        { status: 'in_gate', gate: 'G3' },
        'g6_returned',
        await g3Approvers(tx, policy, intent),
      );
    }
    case 'terminate': {
      if (!(await stillValid(tx, registry, escalation, subjectSha256, 'gate_advance', true))) {
        return wait('publish_review');
      }
      await close(tx, registry, escalation);
      return move(tx, registry, intent, { status: 'cancelled', gate: 'G6' }, 'terminated', []);
    }
    default:
      return wait('publish_review');
  }
}

/** The freeze check (ADR-M28 §2.4). */
async function allowed(
  tx: TenantScope,
  intent: Intent,
  action: 'push' | 'open_pr',
  now: Date,
): Promise<boolean> {
  try {
    await assertActionAllowed(tx, intent.id, action, now);
    return true;
  } catch (error) {
    if (error instanceof EscalationError && error.code === 'frozen') return false;
    throw error;
  }
}

async function move(
  tx: TenantScope,
  registry: Registry,
  intent: Intent,
  to: { readonly status: IntentStatus; readonly gate: 'G3' | 'G4' | 'G6' },
  kind: IntentNoticeKind,
  audience: readonly ProjectRole[],
): Promise<IntentStepResult> {
  const updated = await tx.intents.moveState(intent.id, {
    from: { status: intent.status, currentGate: intent.current_gate },
    to: { status: to.status, currentGate: to.gate },
    at: registry.now(),
  });
  // Under the intent lock the compare-and-set cannot miss; if it does, roll back this step.
  if (!updated) throw new Error(`G6: intent ${intent.id} moved under its lock`);
  await tx.intentNotices.record({
    intentId: intent.id,
    kind,
    status: updated.status,
    gate: updated.current_gate,
    previousGate: intent.current_gate,
    decisionId: null,
    audienceRoles: [...new Set(audience)],
  });
  return moved;
}
