// The kill switch (task C11, D-08 C11 AC1–AC2, D-02 FR-34, D-03 §6.5, design/ADR-M42; QUESTIONS
// #180, #181).
//
// `requestRunKill` records the kill in the database, which is the source of truth; the runner and
// the workflow act on it:
// - who: config `access.kill_roles` (Person A, Person B and governance always, rule M25; never
//   `viewer`). The producer of the run may kill it: killing is containment, never an approval
//   (QUESTIONS #180). An operator kills as `system` (`sdlc ops run kill`);
// - a `queued` run (no runner took it) ends `stopped_killed` at once; a run a runner holds
//   (`provisioning`, `running`) goes to `stopping` with `killed_by`. The runner sees `stopping`
//   within one poll, stops the agent (interrupt, then kill), ends the run `stopped_killed` and
//   removes the sandbox. When the runner is lost, `abandonRun` ends it `stopped_killed`;
// - in the same transaction: the run event `kill_requested`, the escalation for the review (route
//   `technical`, config `run.kill_escalation`, at least `pause`, rule M26: the intent stays frozen
//   until a person decides), the audit event `run.kill_requested` and the status notice
//   `run_killed`. The run's key is revoked when the run ends (`finishRun`, `abandonRun`);
// - a second kill of a `stopping` or `stopped_killed` run changes nothing (`already`); a run that
//   ended otherwise is refused (`run_not_active`).
// The caller then signals the intent's workflow (`kill`, `wake`): the workflow cancels the run's
// activity, which also covers a run that waits for a runner slot in Temporal.
import type { ProjectRole, RunStatus } from '@sdlc/contracts';

import type { CostController } from '../cost/controller.js';
import type { Intent, Run } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { raiseEscalation } from '../escalation/raise.js';
import { loadEffectiveConfig } from '../registry/effective-config.js';
import { isFinalRun } from '../workflow/run-round.js';
import { KillError } from './errors.js';

/** A person kills as themselves; an operator command as the system (D-02 FR-34 "the platform"). */
export type KillActor =
  { readonly type: 'human'; readonly id: string } | { readonly type: 'system' };

export type KillSource = 'api' | 'github_comment' | 'ops';

/** The stop reason of every killed run (migration 0019). */
export const KILLED = 'killed';

/** A run a runner holds: it goes to `stopping` and the runner ends it. */
const HELD: readonly RunStatus[] = ['provisioning', 'running'];

/** The people who act on a kill: the owner and the reviewer (the escalation mentions its own). */
const KILL_AUDIENCE: readonly ProjectRole[] = ['person_a', 'person_b'];

/** Already killed: a second kill changes nothing. */
const KILLED_STATUSES: readonly RunStatus[] = ['stopping', 'stopped_killed'];

export interface KillRunInput {
  readonly runId: string;
  readonly actor: KillActor;
  readonly source: KillSource;
}

export interface KillRunResult {
  readonly runId: string;
  readonly intentId: string;
  /** The run's status after the kill: `stopping`, or `stopped_killed` for a queued run. */
  readonly status: RunStatus;
  /** True when the run was already killed: nothing was recorded again. */
  readonly already: boolean;
  /** The escalation raised for the review; undefined when `already`. */
  readonly escalationId?: string;
}

export interface KillAccess {
  /** Active roles of the user on the project. Empty: the run is invisible to the user. */
  readonly roles: readonly ProjectRole[];
  readonly canKill: boolean;
}

/** Who may kill the runs of a project (`access.kill_roles`). */
export async function killAccess(
  scope: TenantScope,
  projectId: string,
  userId: string,
): Promise<KillAccess> {
  const roles = (await scope.roleBindings.listForUser(userId))
    .filter((binding) => binding.project_id === projectId)
    .map((binding) => binding.role);
  if (roles.length === 0) return { roles, canKill: false };
  const { config } = await loadEffectiveConfig(scope.projectConfigs, projectId);
  return { roles, canKill: roles.some((role) => config.access.kill_roles.includes(role)) };
}

/** Records a kill (see the header). Throws `KillError` for refusals. */
export interface KillDeps {
  /** The registry clock (`Registry.now`). Default: `new Date()`. */
  readonly now?: () => Date;
}

export async function requestRunKill(
  scope: TenantScope,
  deps: KillDeps,
  input: KillRunInput,
): Promise<KillRunResult> {
  const now = deps.now ?? (() => new Date());
  const run = await scope.runs.getById(input.runId);
  if (!run) throw new KillError('run_not_found', 'run not found');
  const intent = await scope.intents.getById(run.intent_id);
  if (!intent) throw new KillError('run_not_found', 'run not found');
  await checkAccess(scope, intent.project_id, input.actor);

  return scope.transaction(async (tx) => {
    const locked = await tx.intents.lockAndGet(intent.id);
    if (!locked) throw new KillError('run_not_found', 'run not found');
    // The role may have been withdrawn meanwhile.
    await checkAccess(tx, intent.project_id, input.actor);
    // A runner may claim a queued run between the read and the update: try the next status.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await tx.runs.getById(run.id);
      if (!current) throw new KillError('run_not_found', 'run not found');
      if (KILLED_STATUSES.includes(current.status)) {
        return { runId: run.id, intentId: intent.id, status: current.status, already: true };
      }
      if (isFinalRun(current.status)) {
        throw new KillError('run_not_active', `run is ${current.status}`);
      }
      const status = await stop(tx, now(), current, input.actor);
      if (status) {
        const escalationId = await recordKill(tx, now, locked, current, input);
        return { runId: run.id, intentId: intent.id, status, already: false, escalationId };
      }
    }
    throw new KillError('run_not_active', 'the run kept changing');
  });
}

/**
 * The worker revokes a killed run's key at once (C11, ADR-M42 §2.3), when the workflow gets the
 * kill signal: the runner then stops the agent, and stores the run's diff only once the gateway
 * refuses the key. Returns false (and revokes nothing) when the run is not being killed. Revoking
 * again later (`finishRun`) is harmless.
 */
export async function revokeKilledRunKey(
  scope: TenantScope,
  deps: { readonly costController: Pick<CostController, 'endRunKey'> },
  runId: string,
): Promise<boolean> {
  const run = await scope.runs.getById(runId);
  if (!run || !KILLED_STATUSES.includes(run.status)) return false;
  await deps.costController.endRunKey({ runId, syncFrom: new Date(run.created_at) });
  return true;
}

/**
 * The escalation route of a failed run (C11, ADR-M42 §2.5): `security` when one of the run's
 * single-use wrapping tokens was already opened (`wrap_token_reused`: someone else may hold the
 * secret), otherwise `technical`.
 */
export async function failedRunRoute(
  scope: TenantScope,
  runId: string,
): Promise<'security' | 'technical'> {
  const events = await scope.runEvents.list(runId);
  return events.some((event) => event.event_type === 'wrap_token_reused')
    ? 'security'
    : 'technical';
}

/** The intent's current run (comment `/kill`, CLI with an intent code). */
export async function currentRunOf(scope: TenantScope, intentId: string): Promise<Run> {
  const latest = (await scope.runs.listForIntent(intentId)).at(-1);
  if (!latest || isFinalRun(latest.status)) {
    throw new KillError('no_active_run', 'the intent has no run to stop');
  }
  return latest;
}

async function checkAccess(scope: TenantScope, projectId: string, actor: KillActor): Promise<void> {
  if (actor.type === 'system') return;
  const access = await killAccess(scope, projectId, actor.id);
  if (access.roles.length === 0) throw new KillError('run_not_found', 'run not found');
  if (!access.canKill) throw new KillError('forbidden', 'the caller may not stop runs');
}

async function stop(
  tx: TenantScope,
  now: Date,
  run: Run,
  actor: KillActor,
): Promise<RunStatus | undefined> {
  const killedBy = actor.type === 'human' ? { killedBy: actor.id } : {};
  if (run.status === 'queued') {
    const moved = await tx.runs.transition(run.id, {
      from: ['queued'],
      to: 'stopped_killed',
      now,
      stopReason: KILLED,
      finishedAt: now,
      ...killedBy,
    });
    return moved ? 'stopped_killed' : undefined;
  }
  if (!HELD.includes(run.status)) return undefined;
  const moved = await tx.runs.transition(run.id, { from: HELD, to: 'stopping', now, ...killedBy });
  return moved ? 'stopping' : undefined;
}

async function recordKill(
  tx: TenantScope,
  now: () => Date,
  intent: Intent,
  run: Run,
  input: KillRunInput,
): Promise<string> {
  await tx.runEvents.append(run.id, 'kill_requested', {
    previous_status: run.status,
    source: input.source,
  });
  const { config } = await loadEffectiveConfig(tx.projectConfigs, intent.project_id);
  const contract = await tx.runContracts.getByRunId(run.id);
  const escalation = await raiseEscalation(
    tx,
    {
      intentId: intent.id,
      runId: run.id,
      trigger: 'risky_action',
      route: 'technical',
      severity: config.run.kill_escalation.severity,
      responseLevel: config.run.kill_escalation.response_level,
      packet: {
        subject_kind: 'run_contract',
        subject_sha256: contract?.contract_sha256 ?? '0'.repeat(64),
        gate: 'G4',
        run_id: run.id,
        agent_id: run.agent_id,
      },
      // The person who allowed the run produced it with the agent (FR-11, FR-18).
      producers: run.triggered_by === null ? [] : [run.triggered_by],
      raisedBy: input.actor,
    },
    { now },
  );
  await tx.audit.append({
    action: 'run.kill_requested',
    actorType: input.actor.type,
    actorId: input.actor.type === 'human' ? input.actor.id : null,
    entityId: run.id,
    occurredAt: now(),
    payload: {
      intent_id: intent.id,
      previous_status: run.status,
      source: input.source,
      escalation_id: escalation.id,
    },
  });
  await tx.intentNotices.record({
    intentId: intent.id,
    kind: 'run_killed',
    status: intent.status,
    gate: intent.current_gate,
    previousGate: intent.current_gate,
    decisionId: null,
    audienceRoles: KILL_AUDIENCE,
  });
  return escalation.id;
}
