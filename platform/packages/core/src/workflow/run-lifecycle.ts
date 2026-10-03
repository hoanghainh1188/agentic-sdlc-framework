// The run of an intent after G4 (task C06 session 2, D-08 C06 AC4, D-03 section 6, design/ADR-M33
// §2.6–§2.7, QUESTIONS #53, #55, #112).
//
// The intent workflow drives one run at a time:
//   G4 decided → the step moves the intent `in_gate G4 → running` (under the intent lock, in the
//   transaction that checked the block window and the freeze) → `run_prepare`
//   → `startRun` (prepareRun: contract, capped key, wrapped secrets) → the runner's activity
//   → the run ends (a final status) → `run_ended` → `finishRun`.
// The database is the source of truth: `stepRunning` looks at the runs started since the intent
// became `running`, so a workflow that starts again (or a lost result) finds its way:
// - no run yet → prepare one;
// - the last run is final → finish it;
// - the last run is `queued` and its contract expired before a runner took it → cancel it
//   (`contract_expired`) and prepare a new attempt, at most `run.contract_attempts_max` times;
// - otherwise the run is under way → wait.
//
// How a run ends (`finishRun`):
// - `succeeded`, or a stop at a cap or the file scope → `in_gate G5` (C07 decides; QUESTIONS #21,
//   #82: a budget or scope stop never resumes by itself);
// - `failed` (the agent, provisioning or the infrastructure) or too many expired contracts →
//   `paused` and a `technical` escalation at `run.failed_run_escalation` (at least `pause`, rule
//   M20; Harry, C06 plan: "Stopped → Escalated: always reviewed", D-03 §6);
// - `succeeded_proposal_only` (L1: the runner stored the proposal as evidence, session 2b) →
//   `paused` with the notice `proposal_ready`; Person A takes the proposal forward (handbook
//   Ch.13 §13.5 Step 4); the intent waits (`proposal_review`);
// - `stopped_killed` → `paused`; the kill switch raised its escalation at the kill (C11,
//   `requestRunKill`, ADR-M42);
// - `cancelled` for another reason (budget, the proposal changed) → back to `in_gate G4`, where
//   G4 is decided again.
// A paused intent goes back to G4 (`stepPaused`) once the run's escalation lets a run start: it
// is closed, or a person decided `resume` for this run's contract (re-checked, FR-17). A decision
// `terminate` closes the intent (`cancelled`, C11).
//
// `abandonRun`: the runner's activity was lost (heartbeat timeout, the runner stopped). The key is
// revoked at once and the run ends `failed` (`runner_lost`), or `stopped_killed` when it was being
// killed (`stopping`, C11). The sandbox is removed by the runner:
// on the activity's cancel when it is still alive, otherwise by its clean-up at start or its sweep
// (ADR-M25 §2.8).
import {
  type IntentStepResult,
  type PolicyEngine,
  type RunStatus,
  type ValidatedProjectConfig,
} from '@sdlc/contracts';

import type { CostController } from '../cost/controller.js';
import type { IntentNoticeKind } from '../db/repositories/intent-notices.js';
import type { Escalation, Intent, Run } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import {
  closeEscalation,
  decisionAllows,
  revalidateEscalationDecision,
} from '../escalation/decide.js';
import { raiseEscalation } from '../escalation/raise.js';
import { failedRunRoute } from '../kill/kill-run.js';
import type { Registry } from '../registry/registry.js';
import { G4_OPERATOR_ROLES } from './g4.js';
import { prepareRun, type PrepareRunDeps, type PrepareRunResult } from './prepare-run.js';
import { isFinalRun, roundRuns } from './run-round.js';

/** Run statuses that go to G5 (C07 decides what happens next). */
const TO_G5: readonly RunStatus[] = [
  'succeeded',
  'stopped_budget',
  'stopped_scope',
  'stopped_timeout',
  'stopped_stalled',
];

/** Runs that are still going: the runner holds them. */
const ACTIVE: readonly RunStatus[] = ['queued', 'provisioning', 'running', 'stopping'];

export const CONTRACT_EXPIRED = 'contract_expired';
export const RUNNER_LOST = 'runner_lost';

const isFinal = isFinalRun;

export interface RunStepPolicy {
  readonly config: ValidatedProjectConfig;
  readonly policy: PolicyEngine;
}

/** The step while the intent is `running` at G4 (see the header). Under the intent lock. */
export async function stepRunning(
  tx: TenantScope,
  registry: Registry,
  policy: RunStepPolicy,
  intent: Intent,
): Promise<IntentStepResult> {
  const runs = await roundRuns(tx, intent);
  const latest = runs.at(-1);
  if (!latest) return { outcome: 'run_prepare' };
  const expired = () =>
    runs.filter((r) => r.status === 'cancelled' && r.stop_reason === CONTRACT_EXPIRED).length;
  if (latest.status === 'queued') {
    const contract = await tx.runContracts.getByRunId(latest.id);
    const now = registry.now();
    if (!contract || new Date(contract.expires_at).getTime() > now.getTime()) {
      return { outcome: 'waiting', reason: 'run_in_progress' };
    }
    // Nobody took the run before its contract expired (QUESTIONS #53): cancel it, try again.
    await tx.runs.transition(latest.id, {
      from: ['queued'],
      to: 'cancelled',
      now,
      stopReason: CONTRACT_EXPIRED,
      finishedAt: now,
    });
    return expired() + 1 < policy.config.run.contract_attempts_max
      ? { outcome: 'run_prepare' }
      : { outcome: 'run_ended', runId: latest.id };
  }
  if (!isFinal(latest.status)) return { outcome: 'waiting', reason: 'run_in_progress' };
  if (
    latest.status === 'cancelled' &&
    latest.stop_reason === CONTRACT_EXPIRED &&
    expired() < policy.config.run.contract_attempts_max
  ) {
    return { outcome: 'run_prepare' };
  }
  return { outcome: 'run_ended', runId: latest.id };
}

/**
 * The step while the intent is `paused` at G4 after a failed run: back to G4 once the run's
 * escalation lets a run start; otherwise wait (`run_review`). After an L1 proposal the intent
 * waits for a person (`proposal_review`): the proposal is taken forward outside the run (handbook
 * Ch.13 §13.5 Step 4), never by a new run. Under the intent lock.
 */
export async function stepPaused(
  tx: TenantScope,
  registry: Registry,
  intent: Intent,
): Promise<IntentStepResult | 'resume'> {
  const latest = (await tx.runs.listForIntent(intent.id)).at(-1);
  if (!latest) return 'resume';
  if (latest.status === 'succeeded_proposal_only') {
    return { outcome: 'waiting', reason: 'proposal_review' };
  }
  const now = registry.now();
  const escalation = (await tx.escalations.listForIntent(intent.id))
    .filter((e) => e.run_id === latest.id)
    .at(-1);
  if (!escalation) return { outcome: 'waiting', reason: 'run_review' };
  if (escalation.status !== 'closed' && String(escalation.decision?.decision) === 'terminate') {
    return terminate(tx, registry, intent, escalation, latest.id, now);
  }
  if (escalation.status !== 'closed') {
    if (!decisionAllows(escalation, 'run_start', now)) {
      return { outcome: 'waiting', reason: 'run_review' };
    }
    const contract = await tx.runContracts.getByRunId(latest.id);
    const check = await revalidateEscalationDecision(
      tx,
      {
        escalationId: escalation.id,
        subjectSha256: contract?.contract_sha256 ?? '',
        action: 'run_start',
      },
      { now: () => now },
    );
    if (!check.valid) return { outcome: 'waiting', reason: 'run_review' };
    await closeEscalation(
      tx,
      { escalationId: escalation.id, closedBy: { type: 'system' } },
      { now: () => now },
    );
  }
  return 'resume';
}

/**
 * `terminate` on the escalation of a failed or killed run (C11): the decision binds the run's
 * contract and has not expired (FR-17), then the intent is closed (`cancelled`).
 */
async function terminate(
  tx: TenantScope,
  registry: Registry,
  intent: Intent,
  escalation: Escalation,
  runId: string,
  now: Date,
): Promise<IntentStepResult> {
  const contract = await tx.runContracts.getByRunId(runId);
  const check = await revalidateEscalationDecision(
    tx,
    {
      escalationId: escalation.id,
      subjectSha256: contract?.contract_sha256 ?? '',
      action: 'gate_advance',
    },
    { now: () => now },
  );
  // `terminate` acts by ending the intent, which no protected action covers (as at G5).
  if (!check.valid && check.reason !== 'scope_mismatch') {
    return { outcome: 'waiting', reason: 'run_review' };
  }
  await closeEscalation(
    tx,
    { escalationId: escalation.id, closedBy: { type: 'system' } },
    { now: () => now },
  );
  const moved = await tx.intents.moveState(intent.id, {
    from: { status: intent.status, currentGate: intent.current_gate },
    to: { status: 'cancelled', currentGate: 'G4' },
    at: now,
  });
  if (moved) {
    await tx.intentNotices.record({
      intentId: intent.id,
      kind: 'terminated',
      status: 'cancelled',
      gate: 'G4',
      previousGate: intent.current_gate,
      decisionId: null,
      audienceRoles: [],
    });
  }
  return { outcome: 'moved' };
}

export interface RunDeps extends PrepareRunDeps {
  readonly costController: PrepareRunDeps['costController'] & Pick<CostController, 'endRunKey'>;
}

/**
 * Prepares the round's next run (`prepareRun`). A refusal takes the intent back to `in_gate G4`,
 * where G4 is decided again, except `run_exists` (a run of this round is already under way).
 */
export async function startRun(
  scope: TenantScope,
  deps: RunDeps,
  intentId: string,
): Promise<PrepareRunResult> {
  const result = await prepareRun(scope, deps, intentId);
  if (!result.ok && result.reason !== 'run_exists' && result.reason !== 'not_at_g4') {
    await scope.transaction(async (tx) => {
      const intent = await tx.intents.lockAndGet(intentId);
      if (intent?.status !== 'running' || intent.current_gate !== 'G4') return;
      if ((await roundRuns(tx, intent)).some((r) => !isFinal(r.status))) return;
      await moveTo(tx, deps.registry, intent, 'in_gate', 'G4', 'run_not_started');
    });
  }
  return result;
}

/**
 * The runner's activity for this run was lost (heartbeat timeout, the runner stopped). Revokes the
 * run's key at once (Harry, C06 session 2 plan), then ends the run `failed` with `reason` if it is
 * not final yet. The workflow then finishes it (`run_ended` → `finishRun`).
 */
export async function abandonRun(
  scope: TenantScope,
  deps: { readonly registry: Registry; readonly costController: Pick<CostController, 'endRunKey'> },
  runId: string,
  reason: string = RUNNER_LOST,
): Promise<void> {
  const run = await scope.runs.getById(runId);
  if (!run) return;
  await deps.costController.endRunKey({ runId, syncFrom: new Date(run.created_at) });
  if (isFinal(run.status)) return;
  const now = deps.registry.now();
  await scope.transaction(async (tx) => {
    // A run being killed ends as killed (C11, migration 0020); any other run fails. One update:
    // a kill that lands in between never leaves the run in `stopping`.
    const moved = await tx.runs.end(runId, {
      from: ACTIVE.filter((status) => status !== 'stopping'),
      to: 'failed',
      now,
      stopReason: reason,
      finishedAt: now,
    });
    if (moved) await tx.runEvents.append(runId, 'run_abandoned', { previous_status: run.status });
  });
}

/**
 * Ends a run in the intent (see the header): revokes the key and syncs spend, then moves the
 * intent. Runs again safely: an intent that is no longer `running` at G4 with this run as its last
 * run is left alone.
 */
export async function finishRun(
  scope: TenantScope,
  deps: { readonly registry: Registry; readonly costController: Pick<CostController, 'endRunKey'> },
  intentId: string,
  runId: string,
): Promise<void> {
  const run = await scope.runs.getById(runId);
  if (!run || run.intent_id !== intentId || !isFinal(run.status)) return;
  await deps.costController.endRunKey({ runId, syncFrom: new Date(run.created_at) });
  await scope.transaction(async (tx) => {
    const intent = await tx.intents.lockAndGet(intentId);
    if (intent?.status !== 'running' || intent.current_gate !== 'G4') return;
    if ((await tx.runs.listForIntent(intentId)).at(-1)?.id !== runId) return;
    const { registry } = deps;
    if (TO_G5.includes(run.status)) {
      await moveTo(tx, registry, intent, 'in_gate', 'G5', 'run_finished');
    } else if (run.status === 'succeeded_proposal_only') {
      await moveTo(tx, registry, intent, 'paused', 'G4', 'proposal_ready');
    } else if (run.status === 'stopped_killed') {
      await moveTo(tx, registry, intent, 'paused', 'G4', 'run_failed');
    } else if (
      run.status === 'failed' ||
      (run.status === 'cancelled' && run.stop_reason === CONTRACT_EXPIRED)
    ) {
      await escalateFailedRun(tx, registry, intent, run);
      await moveTo(tx, registry, intent, 'paused', 'G4', 'run_failed');
    } else {
      // `cancelled` before the run started (budget, the proposal changed): G4 decides again.
      await moveTo(tx, registry, intent, 'in_gate', 'G4', 'run_not_started');
    }
  });
}

/** ADR-M33 §2.7: a failed or lost run is always reviewed; the escalation freezes the intent. */
async function escalateFailedRun(
  tx: TenantScope,
  registry: Registry,
  intent: Intent,
  run: Run,
): Promise<void> {
  const { config } = await registry.policyFor(tx, intent.project_id);
  const contract = await tx.runContracts.getByRunId(run.id);
  const escalation = config.run.failed_run_escalation;
  await raiseEscalation(
    tx,
    {
      intentId: intent.id,
      runId: run.id,
      trigger: 'unusual_behaviour',
      // C11: a wrapping token someone else opened goes to security (ADR-M42 §2.5).
      route: await failedRunRoute(tx, run.id),
      severity: escalation.severity,
      responseLevel: escalation.response_level,
      packet: {
        subject_kind: 'run_contract',
        subject_sha256: contract?.contract_sha256 ?? '0'.repeat(64),
        gate: 'G4',
        run_id: run.id,
        agent_id: run.agent_id,
      },
      // The person who allowed the run produced it with the agent (FR-11, FR-18).
      producers: run.triggered_by === null ? [] : [run.triggered_by],
      raisedBy: { type: 'system' },
    },
    { now: () => registry.now() },
  );
}

export async function moveTo(
  tx: TenantScope,
  registry: Registry,
  intent: Intent,
  status: 'in_gate' | 'paused',
  gate: 'G4' | 'G5',
  kind: IntentNoticeKind,
): Promise<void> {
  const moved = await tx.intents.moveState(intent.id, {
    from: { status: intent.status, currentGate: intent.current_gate },
    to: { status, currentGate: gate },
    at: registry.now(),
  });
  if (!moved) return;
  await tx.intentNotices.record({
    intentId: intent.id,
    kind,
    status,
    gate,
    previousGate: intent.current_gate,
    decisionId: null,
    audienceRoles: G4_OPERATOR_ROLES,
  });
}

/** Moves a decided intent `in_gate G4 → running` (the step, in the transaction that checked G4). */
export async function moveToRunning(
  tx: TenantScope,
  registry: Registry,
  intent: Intent,
): Promise<boolean> {
  const moved = await tx.intents.moveState(intent.id, {
    from: { status: 'in_gate', currentGate: 'G4' },
    to: { status: 'running', currentGate: 'G4' },
    at: registry.now(),
  });
  if (!moved) return false;
  await tx.intentNotices.record({
    intentId: intent.id,
    kind: 'run_started',
    status: 'running',
    gate: 'G4',
    previousGate: 'G4',
    decisionId: null,
    audienceRoles: G4_OPERATOR_ROLES,
  });
  return true;
}
