// The plan re-check at G3 and before the run (task B09, D-08 B09 AC3, D-03 section 6 "plan hash
// changed after G3 → back to G3", design/ADR-M40 §2.4, QUESTIONS #167).
//
// The plan of an intent is its file `.sdlc/plans/<code>.yaml` on the head of the default branch,
// submitted by a person (`plans/submit.ts`). Whenever the intent waits at G3 or G4, the step reads
// the file at the head the spec check read (`gatherPlanFacts`; no HTTP call under the intent lock)
// and then, under the lock (`checkPlan`):
// - at G4, the latest plan is not the one G3 approved or passed (a person submitted a new plan)
//   → back to G3 (notice `plan_changed`); the approvals of G3 and G4 are voided (FR-17);
// - the file at head is not the submitted plan (changed, removed, not readable) → the gate is
//   held (`plan_resubmit_needed`) until a person with a submit role submits the plan again. The
//   platform never takes a new version by itself (QUESTIONS #167): the submitter is the
//   accountable producer of every version, and never approves it at G3 (FR-11);
// - the Git host cannot be read → the gate is held (`git_host_unavailable`); never passes.
// A held G3 refuses only the advance: rejections, requests for changes, blocks of a passed gate
// and the gate's overdue escalation are still handled (as for the spec, ADR-M39 §2.4). A held G4
// waits. Plans stored without a file (before B09) are not re-checked against the repository.
import type {
  GateCode,
  IntentStepResult,
  PolicyEngine,
  ProjectRole,
  ValidatedProjectConfig,
} from '@sdlc/contracts';

import type { Intent, Plan } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { readPlanFile } from '../plans/read.js';
import type { PlanUnreadableCause } from '../plans/rules.js';
import type { Registry } from '../registry/registry.js';
import type { SpecGitHost } from '../specs/link.js';
import { passedInput } from './g4.js';
import { projectRepoRef } from './g4-proposal.js';
import { closeGateOverdue } from './overdue.js';
import { gateOversight } from './oversight.js';
import type { SpecCheckOutcome, SpecHold } from './spec-check.js';

/** The gates at which the step re-checks the plan. */
export const PLAN_CHECK_GATES = ['G3', 'G4'] as const satisfies readonly GateCode[];
type PlanCheckGate = (typeof PLAN_CHECK_GATES)[number];

export function isPlanCheckGate(gate: GateCode | null): gate is PlanCheckGate {
  return gate !== null && (PLAN_CHECK_GATES as readonly string[]).includes(gate);
}

/** What the step read from the Git host for the plan check. */
export interface PlanFacts {
  /** The head of the default branch the file was read at (the spec check's head). */
  readonly headSha: string;
  /** The latest plan when the facts were read; its file at `headSha`. */
  readonly planId: string;
  readonly read:
    | { readonly kind: 'ok'; readonly sha256: string }
    | { readonly kind: 'unreadable'; readonly cause: PlanUnreadableCause };
}

/** Why the plan file at head is not the submitted plan. */
export type PlanResubmitCause = 'changed' | PlanUnreadableCause;

/**
 * Reads the latest plan's file at `headSha`. Null when the intent has no plan read from a file.
 * Throws `GitHostError` when the Git host cannot be read. Call it outside the step's transaction.
 */
export async function gatherPlanFacts(
  scope: TenantScope,
  deps: SpecGitHost,
  intent: Pick<Intent, 'id' | 'code' | 'project_id'>,
  headSha: string,
): Promise<PlanFacts | null> {
  const latest = await scope.plans.latest(intent.id);
  if (!latest || latest.commit_sha === null) return null;
  const project = await scope.projects.getById(intent.project_id);
  const ref = project ? projectRepoRef(project) : undefined;
  if (!ref) return null; // The spec check already failed on the same repository name.
  const read = await readPlanFile(deps.gitHost, ref, intent.code, headSha);
  return {
    headSha,
    planId: latest.id,
    read: read.kind === 'ok' ? { kind: 'ok', sha256: read.sha256 } : read,
  };
}

const moved: SpecCheckOutcome = { kind: 'result', result: { outcome: 'moved' } };
const GIT_HOST_RETRY_MS = 60_000;

interface PlanCheckPolicy {
  readonly config: ValidatedProjectConfig;
  readonly policy: PolicyEngine;
}

/**
 * Applies the plan check under the intent lock. `facts` is `git_host_unavailable` when the Git
 * host could not be read, null when no plan file was read. Returns null when the plan is in
 * order (the step goes on), a result when the check moved the intent, or a hold.
 */
export async function checkPlan(
  tx: TenantScope,
  registry: Registry,
  policy: PlanCheckPolicy,
  intent: Intent,
  facts: PlanFacts | null | 'git_host_unavailable',
): Promise<SpecCheckOutcome | null> {
  const gate = intent.current_gate;
  if (intent.status !== 'in_gate' || !isPlanCheckGate(gate)) return null;
  const latest = await tx.plans.latest(intent.id);
  if (!latest) return null; // G3 waits for a plan (`input_missing`); G4 fails `plan_changed`.

  // A person submitted a new plan after G3 passed (or G3's pass was voided): G3 decides again.
  if (gate === 'G4' && (await passedInput(tx, intent.id, 'G3')) !== latest.plan_sha256) {
    await backToG3(tx, registry, policy, intent);
    return moved;
  }
  if (latest.commit_sha === null) return null; // No file to compare (plans stored before B09).
  if (facts === 'git_host_unavailable') {
    return { kind: 'hold', hold: { reason: 'git_host_unavailable', wakeInMs: GIT_HOST_RETRY_MS } };
  }
  // A plan was submitted after the facts were read: read again.
  if (facts?.planId !== latest.id) return moved;
  if (facts.read.kind === 'ok' && facts.read.sha256 === latest.plan_sha256) return null;

  const cause: PlanResubmitCause = facts.read.kind === 'ok' ? 'changed' : facts.read.cause;
  if (await recordResubmitNeeded(tx, intent, latest, cause, facts.headSha)) {
    await tx.intentNotices.record({
      intentId: intent.id,
      kind: 'plan_resubmit_needed',
      status: 'in_gate',
      gate,
      previousGate: gate,
      decisionId: null,
      audienceRoles: submitters(policy.config),
    });
  }
  const hold: SpecHold = { reason: 'plan_resubmit_needed' };
  return { kind: 'hold', hold };
}

/** Writes `plan.resubmit_needed` once per plan version and cause; true when written now. */
async function recordResubmitNeeded(
  tx: TenantScope,
  intent: Intent,
  plan: Plan,
  cause: PlanResubmitCause,
  headSha: string,
): Promise<boolean> {
  const earlier = await tx.audit.listForEntity(intent.id, ['plan.resubmit_needed']);
  const seen = earlier.some((row) => {
    const payload = row.payload as { plan_id?: unknown; cause?: unknown };
    return payload.plan_id === plan.id && payload.cause === cause;
  });
  if (seen) return false;
  await tx.audit.append({
    action: 'plan.resubmit_needed',
    actorType: 'system',
    actorId: null,
    entityId: intent.id,
    payload: { plan_id: plan.id, cause, head_sha: headSha },
  });
  return true;
}

async function backToG3(
  tx: TenantScope,
  registry: Registry,
  policy: PlanCheckPolicy,
  intent: Intent,
): Promise<void> {
  await closeGateOverdue(tx, registry, intent.id, 'G4');
  // G3 and G4 are decided again: their approvals no longer count (FR-17), so they are voided and
  // the same people may approve again (like the spec's return to G2).
  for (const redo of PLAN_CHECK_GATES) {
    await registry.voidApprovals(tx, {
      intentId: intent.id,
      gate: redo,
      reasonCode: 'input_mismatch',
    });
  }
  const updated = await tx.intents.moveState(intent.id, {
    from: { status: intent.status, currentGate: 'G4' },
    to: { status: 'in_gate', currentGate: 'G3' },
    at: registry.now(),
  });
  if (!updated) return;
  // U02 (QUESTIONS #264): the workflow's own resolution, so after a return from G5, G6 or G7 the
  // notice names G3's HITL approvers.
  const oversight = await gateOversight(tx, policy.policy, intent, 'G3');
  await tx.intentNotices.record({
    intentId: intent.id,
    kind: 'plan_changed',
    status: 'in_gate',
    gate: 'G3',
    previousGate: 'G4',
    decisionId: null,
    audienceRoles: oversight.roles.filter((role) => role !== 'viewer'),
  });
}

/** The roles that submit plans: the people who act on a plan that must be submitted again. */
function submitters(config: ValidatedProjectConfig): ProjectRole[] {
  return config.access.plan_submit_roles.filter((role) => role !== 'viewer').slice(0, 8);
}

/** Exposed for the step: the result of a hold at G4, where nothing else is decided. */
export function heldAtG4(hold: SpecHold): IntentStepResult {
  return hold.wakeInMs === undefined
    ? { outcome: 'waiting', reason: hold.reason }
    : { outcome: 'waiting', reason: hold.reason, wakeInMs: hold.wakeInMs };
}
