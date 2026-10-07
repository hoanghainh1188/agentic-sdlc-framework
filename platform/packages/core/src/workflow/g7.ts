// Gate G7: review and merge (task E01, D-08 E01 AC1–AC5, D-02 FR-11, FR-12, FR-16, FR-17,
// design/D-03 sections 6 and 6.1, design/ADR-M41, QUESTIONS #175–#179, handbook Ch.15 §15.5
// Step 2 and §15.10).
//
// `stepG7` runs when the intent waits `in_gate G7` (G6 passed the run's pull request). The step
// read the pull request before the lock (`readG7`); under the lock, in this order:
//   1. the reading is recorded (`g7_checked`), and the reviews of the pushed commit become gate
//      decisions (`g7-reviews.ts`): approvals bound to the G7 input, requests for changes from a
//      holder of the gate's role who is not a producer; stale review approvals are voided (FR-17);
//   2. a person's rejection takes the intent back to G3, HITL from then on (#178); a valid request
//      for changes takes it to G4 (PR 2, #179): a new run from the pushed commit, which gets the
//      reviewer's feedback (`g7-feedback.ts`); no retry limit (each round needs a person);
//   3. the pull request closed without a merge, or showing another commit than the platform
//      pushed → `paused` at G7 and a `technical` escalation;
//   4. merged: with the pushed commit, by a person who is not a producer, after enough valid
//      approvals → G7 passed: run event `pr_merged`, audit `intent.pr_merged`, and `in_gate G8`
//      (after the G6 block window and the freeze check). Otherwise a system `fail
//      merged_before_approval`, `paused` and a `security` escalation (#177);
//   5. open, approvals complete → wait for a person to merge (`g7_merge`); otherwise wait for
//      reviews (`g7_decision`). The gate deadline applies until the merge (FR-12).
// G7 is HITL at every tier (rule M2): the approvals needed come from the matrix, the dual-approval
// flags of the plan G3 approved, and Critical risk (FR-16). The platform never merges.
//
// `stepPausedG7` acts on the escalation's decision, re-checked just before acting (FR-17):
//   `resume` → back to `in_gate G7`: the step reads the pull request again (a person reopens it or
//     restores the branch first); after an early merge, late approvals of the merged commit count;
//   `modify` or `roll_back` → back to G3, HITL (a person reverts a merged change on the default
//     branch; the platform never writes to it);
//   `terminate` → the intent ends `cancelled`.
import type {
  EscalationRoute,
  IntentStepResult,
  IntentStatus,
  OversightResolution,
  ProjectRole,
} from '@sdlc/contracts';

import { userOfAccount } from '../commands/git-event-handler.js';
import type { IntentNoticeKind } from '../db/repositories/intent-notices.js';
import type { Escalation, Intent } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import type { GitProvider } from '../db/vocabulary.js';
import { EscalationError } from '../escalation/errors.js';
import { assertActionAllowed } from '../escalation/freeze.js';
import { raiseEscalation } from '../escalation/raise.js';
import type { Registry } from '../registry/registry.js';
import { G4_OPERATOR_ROLES } from './g4.js';
import { close, g3Approvers, stillValid, type G5Policy } from './g5.js';
import {
  g7Producers,
  gatherG7Facts,
  recordG7Reading,
  type G7Facts,
  type G7Merger,
  type G7Reading,
} from './g7-facts.js';
import { isReviewReceipt, recordReviews, voidStaleReviewApprovals } from './g7-reviews.js';
import { gateHistory } from './gate-history.js';
import { hotlBlockWindowOpenUntil } from './hotl.js';
import { checkGateOverdue, closeGateOverdue, gateClockStart } from './overdue.js';
import { resolveGateOversight } from './oversight.js';

/** Why G7 stopped (audit `gate.g7_check_failed`). */
export type G7Check =
  | 'pr_closed'
  | 'head_changed'
  | 'merged_before_approval'
  | 'merged_other_head'
  | 'merged_by_producer';

const STOPS: Readonly<Record<G7Check, { route: EscalationRoute; merged: boolean }>> = {
  pr_closed: { route: 'technical', merged: false },
  head_changed: { route: 'technical', merged: false },
  // An unapproved or unchecked change is on the default branch (QUESTIONS #177).
  merged_before_approval: { route: 'security', merged: true },
  merged_other_head: { route: 'security', merged: true },
  merged_by_producer: { route: 'security', merged: true },
};

/** Delay before the step reads the Git host again after an outage (as at G4 and G6). */
const GIT_HOST_RETRY_MS = 60_000;

type Waiting = Extract<IntentStepResult, { outcome: 'waiting' }>;
const moved: IntentStepResult = { outcome: 'moved' };
const wait = (reason: Waiting['reason'], wakeInMs?: number): IntentStepResult =>
  wakeInMs === undefined
    ? { outcome: 'waiting', reason }
    : { outcome: 'waiting', reason, wakeInMs };

/** The step at `in_gate G7` (see the header). Under the intent lock. */
export async function stepG7(
  tx: TenantScope,
  registry: Registry,
  policy: G5Policy,
  intent: Intent,
  /** What the step read before the lock; `unavailable`: the Git host could not be read. */
  reading: G7Reading | 'unavailable' | null,
): Promise<IntentStepResult> {
  const facts = await gatherG7Facts(tx, intent);
  if (!facts) return wait('not_in_gate');
  const project = await tx.projects.getById(intent.project_id);
  const provider: GitProvider = project?.git_provider ?? 'github';
  const fresh = reading !== null && reading !== 'unavailable' && reading.runId === facts.run.id;

  const authors = fresh ? await authorUsers(tx, provider, reading) : [];
  const producers = await g7Producers(tx, intent, authors);
  const accepted = await acceptedMerge(tx, intent.id, facts.inputSha256);
  let merger: G7Merger | null = null;
  if (fresh) {
    merger = reading.prState === 'merged' ? await mergerOf(tx, provider, reading, producers) : null;
    await recordG7Reading(tx, reading, merger);
    if (reading.headSha === facts.pushedHead) {
      await recordReviews(
        tx,
        registry,
        {
          intent,
          provider,
          prNumber: facts.prNumber,
          headSha: facts.pushedHead,
          inputSha256: facts.inputSha256,
          producers,
          mergedAt: reading.mergedAt ? new Date(reading.mergedAt) : null,
          lateAllowed: accepted,
        },
        reading.reviews,
      );
      await voidStaleReviewApprovals(tx, registry, intent, facts.pushedHead, reading.reviews);
    }
  }

  const history = await gateHistory(tx, intent.id, 'G7');
  if (history.rejection !== null) {
    return returnToG3(tx, registry, policy, intent, history.rejection);
  }
  if (reading === 'unavailable') return wait('git_host_unavailable', GIT_HOST_RETRY_MS);
  if (!fresh) return wait('g7_decision', GIT_HOST_RETRY_MS);

  if (reading.prState === 'closed') return stop(tx, registry, policy, intent, facts, 'pr_closed');
  if (reading.prState === 'open' && reading.headSha !== facts.pushedHead) {
    return stop(tx, registry, policy, intent, facts, 'head_changed');
  }

  const oversight = oversightAt(policy, intent, await flagsOf(tx, intent));
  // The G7 input binds the run, its pushed head and the plan's flags, so every approval still
  // valid for it counts, also after a stay at `paused G7` (a review is recorded once).
  const { valid: approvals } = await registry.revalidateApprovals(tx, {
    intentId: intent.id,
    gate: 'G7',
    inputSha256: facts.inputSha256,
  });
  const request = await activeChangesRequest(tx, intent.id, facts.inputSha256, reading, history);
  const complete = request === null && approvals.length >= Math.max(1, oversight.approvalsNeeded);

  if (reading.prState === 'merged') {
    if (reading.headSha !== facts.pushedHead) {
      return stop(tx, registry, policy, intent, facts, 'merged_other_head');
    }
    if (merger !== 'person' && !accepted) {
      return stop(tx, registry, policy, intent, facts, 'merged_by_producer');
    }
    if (complete) return passMerged(tx, registry, intent, facts, reading, approvals.at(-1)!.id);
    if (!accepted) return stop(tx, registry, policy, intent, facts, 'merged_before_approval');
  }
  if (request !== null) {
    // PR 2 (QUESTIONS #179): a new run from the pushed commit, like a G6 retry; no retry limit
    // (each round needs a person's request; the intent budget caps the cost). The next run makes
    // another G7 input, so the approvals of this one no longer count.
    return move(tx, registry, intent, { status: 'in_gate', gate: 'G4' }, 'g7_changes_requested', {
      decisionId: request,
      audience: G4_OPERATOR_ROLES,
    });
  }

  const overdue = await checkGateOverdue(tx, registry, {
    intent,
    gate: 'G7',
    config: policy.config,
    oversight,
    clockStart: gateClockStart(intent, history.latestChangesRequestAt),
    subject: { kind: 'g7_input', sha256: facts.inputSha256 },
    producers,
  });
  if (complete) {
    if (!(await noticedSinceEntry(tx, intent.id, 'g7_merge_ready'))) {
      await notice(tx, intent, 'g7_merge_ready', ['person_b'], approvals.at(-1)!.id);
    }
    return wait('g7_merge', overdue);
  }
  if (!(await noticedSinceEntry(tx, intent.id, 'g7_review_needed'))) {
    await notice(tx, intent, 'g7_review_needed', reviewers(oversight), null);
  }
  return wait('g7_decision', overdue);
}

/**
 * The request for changes in force at G7 for this input, or null. A request from a review holds
 * only while that review is still its reviewer's latest decision on the pushed commit (a dismissed
 * or replaced review no longer holds G7); a request from a command (a `/request-changes G7`
 * comment, whose receipt is a comment's, or the API before QUESTIONS #190) holds when it is the
 * latest since the intent entered G7. Only a `github:review:` receipt makes a request a review's
 * (fix to E01 PR 1: a comment's receipt was taken for a review's, so the request never held).
 */
async function activeChangesRequest(
  tx: TenantScope,
  intentId: string,
  inputSha256: string,
  reading: G7Reading,
  history: Awaited<ReturnType<typeof gateHistory>>,
): Promise<string | null> {
  const requests = (await tx.gateDecisions.listForIntent(intentId, 'G7')).filter(
    (d) => d.decision === 'request_changes' && d.input_sha256 === inputSha256,
  );
  for (const request of requests.reverse()) {
    const receipt = await tx.gitEventReceipts.findByDecision(request.id);
    if (receipt === undefined || !isReviewReceipt(receipt.event_id)) {
      if (request.id === history.latestChangesRequest) return request.id;
      continue;
    }
    const review = reading.reviews.find((r) => r.eventId === receipt.event_id);
    if (review?.state === 'changes_requested' && review.commitSha === reading.headSha) {
      return request.id;
    }
  }
  return null;
}

/** The platform users among the pull request's commit authors (AC2), mapped by numeric ID. */
async function authorUsers(
  tx: TenantScope,
  provider: GitProvider,
  reading: G7Reading,
): Promise<string[]> {
  const users: string[] = [];
  for (const account of reading.authors.accounts) {
    if (account.type !== 'user') continue;
    const user = await userOfAccount(tx, provider, account.id);
    if (user !== undefined) users.push(user);
  }
  return users;
}

/**
 * Who merged the pull request (QUESTIONS #177): a person is an active platform user, linked by the
 * numeric account ID, who is not a producer. Anything else fails closed.
 */
async function mergerOf(
  tx: TenantScope,
  provider: GitProvider,
  reading: G7Reading,
  producers: readonly string[],
): Promise<G7Merger> {
  const by = reading.mergedBy;
  if (by === null) return 'unknown';
  if (by.type === 'bot') return 'bot';
  const user = await userOfAccount(tx, provider, by.id);
  if (user === undefined) return 'unknown';
  return producers.includes(user) ? 'producer' : 'person';
}

/**
 * A `resume` on a G7 merge escalation for exactly this input (QUESTIONS #177): the people who
 * decide accept the early merge, and late approvals of the merged commit may count.
 */
async function acceptedMerge(
  tx: TenantScope,
  intentId: string,
  inputSha256: string,
): Promise<boolean> {
  return (await tx.escalations.listForIntent(intentId)).some(
    (e) =>
      // Acted on: `stepPausedG7` closes it only after re-checking the decision (FR-17).
      e.status === 'closed' &&
      e.packet.gate === 'G7' &&
      e.packet.reason_code === 'merged_before_approval' &&
      e.packet.subject_sha256 === inputSha256 &&
      String(e.decision?.decision) === 'resume',
  );
}

async function flagsOf(tx: TenantScope, intent: Intent) {
  return (await tx.plans.latest(intent.id))?.change_flags ?? [];
}

function oversightAt(
  policy: G5Policy,
  intent: Intent,
  changeFlags: Awaited<ReturnType<typeof flagsOf>>,
): OversightResolution {
  return resolveGateOversight(policy.policy, intent, 'G7', { changeFlags });
}

function reviewers(oversight: OversightResolution): ProjectRole[] {
  return oversight.roles.filter((role) => role !== 'viewer');
}

/** G7 passed: the approved commit is merged (AC5). */
async function passMerged(
  tx: TenantScope,
  registry: Registry,
  intent: Intent,
  facts: G7Facts,
  reading: G7Reading,
  decisionId: string,
): Promise<IntentStepResult> {
  const now = registry.now();
  // The G6 block window: a person may still block G6, which would send the intent back.
  const until = await hotlBlockWindowOpenUntil(tx, registry, intent.id, now);
  if (until !== null) return wait('later_gate', Math.max(0, until.getTime() - now.getTime()));
  if (!(await allowed(tx, intent, registry))) return wait('frozen');
  await closeGateOverdue(tx, registry, intent.id, 'G7');
  const merge = reading.mergeCommitSha ? { merge_commit_sha: reading.mergeCommitSha } : {};
  await tx.runEvents.append(facts.run.id, 'pr_merged', {
    pr_number: facts.prNumber,
    head_sha: facts.pushedHead,
    ...merge,
  });
  await tx.audit.append({
    action: 'intent.pr_merged',
    actorType: 'system',
    actorId: null,
    entityId: intent.id,
    occurredAt: now,
    payload: {
      run_id: facts.run.id,
      pr_number: facts.prNumber,
      head_sha: facts.pushedHead,
      ...merge,
    },
  });
  return move(tx, registry, intent, { status: 'in_gate', gate: 'G8' }, 'merged', {
    decisionId,
    audience: ['person_b'],
  });
}

/** A rejection at G7 (QUESTIONS #178): back to G3, HITL from then on; G3 approvals voided. */
async function returnToG3(
  tx: TenantScope,
  registry: Registry,
  policy: G5Policy,
  intent: Intent,
  decisionId: string,
): Promise<IntentStepResult> {
  await registry.voidApprovals(tx, {
    intentId: intent.id,
    gate: 'G3',
    reasonCode: 'input_mismatch',
  });
  return move(tx, registry, intent, { status: 'in_gate', gate: 'G3' }, 'g7_returned', {
    decisionId,
    audience: await g3Approvers(tx, policy, intent),
  });
}

/** Pauses the intent at G7 with an escalation bound to the G7 input. */
async function stop(
  tx: TenantScope,
  registry: Registry,
  policy: G5Policy,
  intent: Intent,
  facts: G7Facts,
  check: G7Check,
): Promise<IntentStepResult> {
  const kind = STOPS[check];
  const producers = await g7Producers(tx, intent);
  const decision = kind.merged
    ? await registry.decide(tx, {
        intentId: intent.id,
        gate: 'G7',
        decision: 'fail',
        actor: { type: 'system' },
        reasonCode: 'merged_before_approval',
        inputSha256: facts.inputSha256,
        source: 'workflow',
      })
    : null;
  const level = policy.config.run.failed_run_escalation;
  const escalation = await raiseEscalation(
    tx,
    {
      intentId: intent.id,
      runId: facts.run.id,
      trigger: kind.merged ? 'risky_action' : 'unusual_behaviour',
      route: kind.route,
      severity: level.severity,
      responseLevel: level.response_level,
      packet: {
        subject_kind: 'g7_input',
        subject_sha256: facts.inputSha256,
        gate: 'G7',
        run_id: facts.run.id,
        agent_id: facts.run.agent_id,
        reason_code: kind.merged ? 'merged_before_approval' : 'input_mismatch',
      },
      producers,
      raisedBy: { type: 'system' },
    },
    { now: () => registry.now() },
  );
  await tx.audit.append({
    action: 'gate.g7_check_failed',
    actorType: 'system',
    actorId: null,
    entityId: intent.id,
    occurredAt: registry.now(),
    payload: {
      ...(decision ? { decision_id: decision.id } : {}),
      check,
      run_id: facts.run.id,
      escalation_id: escalation.id,
    },
  });
  return move(tx, registry, intent, { status: 'paused', gate: 'G7' }, 'g7_escalated', {
    decisionId: decision?.id ?? null,
    audience: kind.route === 'security' ? ['person_b', 'governance'] : G4_OPERATOR_ROLES,
  });
}

/** The step at `paused G7`: acts on the escalation's decision (see the header). Under the lock. */
export async function stepPausedG7(
  tx: TenantScope,
  registry: Registry,
  policy: G5Policy,
  intent: Intent,
): Promise<IntentStepResult> {
  const escalation = (await tx.escalations.listForIntent(intent.id))
    .filter((e) => e.packet.gate === 'G7' && e.trigger !== 'time')
    .at(-1);
  if (!escalation) return wait('g7_review');
  const current = (await gatherG7Facts(tx, intent))?.inputSha256 ?? null;
  // Closed without a decision acted on, or the input changed: G7 reads the pull request again
  // (and raises a new escalation if the problem is still there).
  if (escalation.status === 'closed' || current !== escalation.packet.subject_sha256) {
    if (escalation.status !== 'closed') await close(tx, registry, escalation);
    return resumeAtG7(tx, registry, intent);
  }
  if (escalation.decision === null) return wait('g7_review');
  return actOn(tx, registry, policy, intent, escalation, String(escalation.packet.subject_sha256));
}

async function actOn(
  tx: TenantScope,
  registry: Registry,
  policy: G5Policy,
  intent: Intent,
  escalation: Escalation,
  subjectSha256: string,
): Promise<IntentStepResult> {
  switch (String(escalation.decision?.decision)) {
    case 'resume': {
      if (!(await stillValid(tx, registry, escalation, subjectSha256, 'gate_advance', true))) {
        return wait('g7_review');
      }
      await close(tx, registry, escalation);
      return resumeAtG7(tx, registry, intent);
    }
    case 'modify':
    case 'roll_back': {
      if (!(await stillValid(tx, registry, escalation, subjectSha256, 'gate_advance', true))) {
        return wait('g7_review');
      }
      await close(tx, registry, escalation);
      await registry.voidApprovals(tx, {
        intentId: intent.id,
        gate: 'G3',
        reasonCode: 'input_mismatch',
      });
      return move(tx, registry, intent, { status: 'in_gate', gate: 'G3' }, 'g7_returned', {
        decisionId: null,
        audience: await g3Approvers(tx, policy, intent),
      });
    }
    case 'terminate': {
      if (!(await stillValid(tx, registry, escalation, subjectSha256, 'gate_advance', true))) {
        return wait('g7_review');
      }
      await close(tx, registry, escalation);
      return move(tx, registry, intent, { status: 'cancelled', gate: 'G7' }, 'terminated', {
        decisionId: null,
        audience: [],
      });
    }
    default:
      return wait('g7_review');
  }
}

function resumeAtG7(tx: TenantScope, registry: Registry, intent: Intent) {
  return move(tx, registry, intent, { status: 'in_gate', gate: 'G7' }, 'g7_resumed', {
    decisionId: null,
    audience: ['person_b'],
  });
}

/** The freeze check before an advance (ADR-M28 §2.4). */
async function allowed(tx: TenantScope, intent: Intent, registry: Registry): Promise<boolean> {
  try {
    await assertActionAllowed(tx, intent.id, 'gate_advance', registry.now());
    return true;
  } catch (error) {
    if (error instanceof EscalationError && error.code === 'frozen') return false;
    throw error;
  }
}

/**
 * Whether people were already told `kind` during this stay at G7: a notice of `kind` after the
 * last notice that moved the intent into G7 (from another gate, or back from `paused G7`).
 */
async function noticedSinceEntry(
  tx: TenantScope,
  intentId: string,
  kind: IntentNoticeKind,
): Promise<boolean> {
  const notices = await tx.intentNotices.listForIntent(intentId);
  let entry = -1;
  notices.forEach((n, i) => {
    if (n.gate === 'G7' && (n.previous_gate !== 'G7' || n.kind === 'g7_resumed')) entry = i;
  });
  return notices.slice(entry + 1).some((n) => n.kind === kind && n.gate === 'G7');
}

async function notice(
  tx: TenantScope,
  intent: Intent,
  kind: IntentNoticeKind,
  audience: readonly ProjectRole[],
  decisionId: string | null,
): Promise<void> {
  await tx.intentNotices.record({
    intentId: intent.id,
    kind,
    status: intent.status,
    gate: intent.current_gate,
    previousGate: intent.current_gate,
    decisionId,
    audienceRoles: [...new Set(audience.filter((role) => role !== 'viewer'))],
  });
}

async function move(
  tx: TenantScope,
  registry: Registry,
  intent: Intent,
  to: { readonly status: IntentStatus; readonly gate: 'G3' | 'G4' | 'G7' | 'G8' },
  kind: IntentNoticeKind,
  notice_: { readonly decisionId: string | null; readonly audience: readonly ProjectRole[] },
): Promise<IntentStepResult> {
  if (intent.status === 'in_gate' && intent.current_gate === 'G7') {
    await closeGateOverdue(tx, registry, intent.id, 'G7');
  }
  const updated = await tx.intents.moveState(intent.id, {
    from: { status: intent.status, currentGate: intent.current_gate },
    to: { status: to.status, currentGate: to.gate },
    at: registry.now(),
  });
  // Under the intent lock the compare-and-set cannot miss; if it does, roll back this step.
  if (!updated) throw new Error(`G7: intent ${intent.id} moved under its lock`);
  await tx.intentNotices.record({
    intentId: intent.id,
    kind,
    status: updated.status,
    gate: updated.current_gate,
    previousGate: intent.current_gate,
    decisionId: notice_.decisionId,
    audienceRoles: [...new Set(notice_.audience.filter((role) => role !== 'viewer'))],
  });
  return moved;
}
