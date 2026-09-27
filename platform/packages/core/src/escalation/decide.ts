// Acknowledging, deciding, re-checking and closing an escalation (D-08 B11 AC5, D-02 FR-17, FR-18;
// handbook Ch.6 §6.4–§6.6, template T16 §4; QUESTIONS #77; design/ADR-M28 §2.4, §2.7).
//
// - Who may act: a person holding the owner role of the route, the backup role once the escalation
//   reached the backup step, or governance at any time; never a producer of the change (FR-18:
//   authority never passes back to them), never an agent or a bot. Humans only: the caller passes a
//   platform user ID, which the API and the comment handler resolve from a token or a numeric
//   GitHub account ID.
// - A decision is bound to the reviewed version (the packet's `subject_sha256`), a scope (the
//   protected actions it allows) and an expiry (`oversight.approval_expiry`). Just before acting,
//   the caller calls `revalidateEscalationDecision`: an expired or mismatched decision is voided
//   (resolved → acknowledged) and the escalation waits for a new decision (Ch.6 §6.6).
// - `escalate_further` records no decision: it moves the escalation to governance.
// - Every step appends an audit event with codes only. The reason text stays in the Git host
//   comment; the decision stores its link (`ref`).
import { deadlineFrom } from '@sdlc/config';
import {
  PROTECTED_ACTIONS,
  type EscalationDecision,
  type EscalationRouting,
  type EscalationStep,
  type GateReasonCode,
  type ProjectRole,
  type ProtectedAction,
  type ValidatedProjectConfig,
} from '@sdlc/contracts';

import type { Escalation } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { loadEffectiveConfig } from '../registry/effective-config.js';
import { clockStateOf } from './advance.js';
import { nextCheckAt, stepWindow } from './clock.js';
import { EscalationError } from './errors.js';
import { clockNotices } from './notices.js';
import type { EscalationDeps, EscalationRaiser } from './raise.js';
import { GOVERNANCE_ROLE } from './routing.js';

/**
 * What a decision allows when the decider names no actions. A mechanism of the platform, not a
 * handbook rule: `roll_back` and `terminate` allow no protected action (the caller cancels or rolls
 * back, which is never frozen), `resume` allows continuing the run, `modify` moving the intent back
 * through its gates. `budget_increase` is never a default (Harry, PR #98): a decision allows it
 * only when it names it with an amount (`budgetIncreaseUsd`), so a comment never raises a budget.
 */
export const DEFAULT_DECISION_ACTIONS: Readonly<
  Record<Exclude<EscalationDecision, 'escalate_further'>, readonly ProtectedAction[]>
> = {
  resume: ['run_resume', 'run_start', 'gate_advance'],
  modify: ['gate_advance'],
  roll_back: [],
  terminate: [],
};

const HTTPS_REF = /^https:\/\/[^\s@]{1,504}$/;
/** USD as a decimal string, above zero (D-05 D6: numeric(18,6), never a float). */
const BUDGET_USD = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/;

export interface AcknowledgeInput {
  readonly escalationId: string;
  readonly actorId: string;
}

export interface DecideInput {
  readonly escalationId: string;
  readonly actorId: string;
  readonly decision: EscalationDecision;
  readonly reasonCode?: GateReasonCode | null;
  /** `https://` link to the words (the Git host comment). */
  readonly reasonRef?: string | null;
  /** Protected actions the decision allows. Default: `DEFAULT_DECISION_ACTIONS[decision]`. */
  readonly actions?: readonly ProtectedAction[];
  /**
   * The budget increase in USD (decimal string), required exactly when `actions` names
   * `budget_increase`. Bound in the decision and audited; the caller (C07) may raise the budget
   * by this amount at most.
   */
  readonly budgetIncreaseUsd?: string;
}

export interface RevalidateInput {
  readonly escalationId: string;
  /** The hash of the version about to be acted on. */
  readonly subjectSha256: string;
  readonly action: ProtectedAction;
}

export type RevalidateResult =
  | { readonly valid: true }
  | {
      readonly valid: false;
      /** `expired` and `input_mismatch` void the decision; the others leave it as it is. */
      readonly reason: 'not_decided' | 'expired' | 'input_mismatch' | 'scope_mismatch';
    };

type Settings = ValidatedProjectConfig;

/** Roles that may act at a step (ADR-M28 §2.4): owner role, backup role from the backup step, governance. */
export function actingRoles(step: EscalationStep, routing: EscalationRouting): ProjectRole[] {
  const roles: ProjectRole[] = [routing.owner_role];
  if (step !== 'owner' && routing.backup_role !== null) roles.push(routing.backup_role);
  roles.push(GOVERNANCE_ROLE);
  return [...new Set(roles)];
}

function now(deps: EscalationDeps): Date {
  return deps.now ? deps.now() : new Date();
}

interface Locked {
  readonly row: Escalation;
  readonly projectId: string;
  readonly config: Settings;
}

async function lockOpen(tx: TenantScope, escalationId: string): Promise<Locked> {
  const row = await tx.escalations.lockForUpdate(escalationId);
  if (!row) throw new EscalationError('not_found', `escalation ${escalationId} not found`);
  const intent = await tx.intents.getById(row.intent_id);
  if (!intent) throw new EscalationError('not_found', `escalation ${row.code}: intent missing`);
  const { config } = await loadEffectiveConfig(tx.projectConfigs, intent.project_id);
  return { row, projectId: intent.project_id, config };
}

async function assertMayAct(tx: TenantScope, locked: Locked, actorId: string): Promise<void> {
  const { row, projectId, config } = locked;
  const forbidden = () =>
    new EscalationError('forbidden', `user may not act on escalation ${row.code}`);
  if (row.producer_ids.includes(actorId)) throw forbidden();
  const user = await tx.users.getById(actorId);
  if (user?.status !== 'active') throw forbidden();
  const allowed = actingRoles(row.current_step, config.escalation.routing[row.route]);
  const roles = (await tx.roleBindings.listForUser(actorId))
    .filter((binding) => binding.project_id === projectId)
    .map((binding) => binding.role);
  if (!roles.some((role) => allowed.includes(role))) throw forbidden();
}

function assertNotFinished(row: Escalation): void {
  if (row.status === 'closed' || row.status === 'resolved') {
    throw new EscalationError('not_open', `escalation ${row.code} is ${row.status}`);
  }
}

/** Acknowledges an open escalation: the acknowledge clock stops, the resolve clock keeps running. */
export async function acknowledgeEscalation(
  scope: TenantScope,
  input: AcknowledgeInput,
  deps: EscalationDeps = {},
): Promise<Escalation> {
  const at = now(deps);
  return await scope.transaction(async (tx) => {
    const locked = await lockOpen(tx, input.escalationId);
    const { row } = locked;
    assertNotFinished(row);
    if (row.status === 'acknowledged') {
      throw new EscalationError('already_acknowledged', `escalation ${row.code} is acknowledged`);
    }
    await assertMayAct(tx, locked, input.actorId);
    const next = nextCheckAt({ ...clockStateOf(row), status: 'acknowledged' });
    const updated = await tx.escalations.updateState(
      row.id,
      {
        status: 'acknowledged',
        acknowledgedBy: input.actorId,
        acknowledgedAt: at,
        nextCheckAt: next,
      },
      at,
    );
    await tx.audit.append({
      action: 'escalation.acknowledged',
      actorType: 'human',
      actorId: input.actorId,
      entityId: row.id,
      payload: { code: row.code, step: row.current_step },
    });
    return updated;
  });
}

/** Records a decision (T16 §4), or moves the escalation to governance (`escalate_further`). */
export async function decideEscalation(
  scope: TenantScope,
  input: DecideInput,
  deps: EscalationDeps = {},
): Promise<Escalation> {
  const at = now(deps);
  if (input.reasonRef != null && !HTTPS_REF.test(input.reasonRef)) {
    throw new EscalationError('decision_not_allowed', 'reason_ref must be an https link');
  }
  const actions = input.actions;
  if (actions !== undefined && input.decision === 'escalate_further') {
    throw new EscalationError('decision_not_allowed', 'escalate_further takes no actions');
  }
  if (actions?.some((action) => !(PROTECTED_ACTIONS as readonly string[]).includes(action))) {
    throw new EscalationError('decision_not_allowed', 'unknown action in the decision scope');
  }
  checkBudgetIncrease(actions, input.budgetIncreaseUsd);
  return await scope.transaction(async (tx) => {
    const locked = await lockOpen(tx, input.escalationId);
    assertNotFinished(locked.row);
    await assertMayAct(tx, locked, input.actorId);
    return input.decision === 'escalate_further'
      ? escalateFurther(tx, locked, input.actorId, at)
      : recordDecision(tx, locked, input, at);
  });
}

async function escalateFurther(
  tx: TenantScope,
  { row, config }: Locked,
  actorId: string,
  at: Date,
): Promise<Escalation> {
  if (row.current_step === 'governance') {
    throw new EscalationError('decision_not_allowed', `escalation ${row.code} is at governance`);
  }
  // An open escalation gets a fresh acknowledge window for governance; an acknowledged one keeps
  // its status and its resolve clock, and governance now decides. `reminded_step` stays: it names
  // the earlier step, so the governance reminder is still due (clock rule: reminded ≠ current).
  const window = row.status === 'open' ? stepWindow(at, row.severity, config.escalation) : null;
  const state = {
    ...clockStateOf(row),
    currentStep: 'governance' as const,
    ...(window ? { stepDueAt: window.dueAt, remindAt: window.remindAt } : {}),
  };
  const updated = await tx.escalations.updateState(
    row.id,
    {
      currentStep: 'governance',
      ...(window ? { stepDueAt: window.dueAt, remindAt: window.remindAt } : {}),
      nextCheckAt: nextCheckAt(state),
    },
    at,
  );
  await tx.audit.append({
    action: 'escalation.escalated_further',
    actorType: 'human',
    actorId,
    entityId: row.id,
    payload: { code: row.code, from_step: row.current_step },
  });
  await tx.escalationNotices.record(
    row.id,
    clockNotices(
      { kind: 'step_changed', at, from: row.current_step, to: 'governance' },
      row.route,
      config.escalation,
    ),
  );
  return updated;
}

async function recordDecision(
  tx: TenantScope,
  { row, config }: Locked,
  input: DecideInput,
  at: Date,
): Promise<Escalation> {
  const decision = input.decision as Exclude<EscalationDecision, 'escalate_further'>;
  const expiresAt = deadlineFrom(at, config.oversight.approval_expiry, config.escalation.calendar)!;
  const subject = String(row.packet.subject_sha256);
  const allowed = input.actions ?? DEFAULT_DECISION_ACTIONS[decision];
  const stored: Record<string, string | boolean> = {
    decision,
    subject_sha256: subject,
    expires_at: expiresAt.toISOString(),
    ...(input.reasonCode ? { reason_code: input.reasonCode } : {}),
    ...(input.reasonRef ? { ref: input.reasonRef } : {}),
    ...Object.fromEntries(allowed.map((action) => [`allow_${action}`, true])),
    ...(input.budgetIncreaseUsd ? { budget_increase_usd: input.budgetIncreaseUsd } : {}),
  };
  const updated = await tx.escalations.updateState(
    row.id,
    {
      status: 'resolved',
      ...(row.acknowledged_at === null
        ? { acknowledgedBy: input.actorId, acknowledgedAt: at }
        : {}),
      decision: stored,
      decidedBy: input.actorId,
      decidedAt: at,
      nextCheckAt: null,
    },
    at,
  );
  await tx.audit.append({
    action: 'escalation.decided',
    actorType: 'human',
    actorId: input.actorId,
    entityId: row.id,
    payload: {
      code: row.code,
      decision,
      subject_sha256: subject,
      ...(input.reasonCode ? { reason_code: input.reasonCode } : {}),
      ...(input.budgetIncreaseUsd ? { budget_increase_usd: input.budgetIncreaseUsd } : {}),
    },
  });
  return updated;
}

/**
 * A budget increase is allowed only when named with an amount, and an amount only with the action
 * (Harry, PR #98). The amount must be above zero.
 */
function checkBudgetIncrease(
  actions: readonly ProtectedAction[] | undefined,
  amount: string | undefined,
): void {
  const named = actions?.includes('budget_increase') ?? false;
  if (named !== (amount !== undefined)) {
    throw new EscalationError(
      'decision_not_allowed',
      'budget_increase needs an amount, and an amount needs budget_increase',
    );
  }
  if (amount !== undefined && (!BUDGET_USD.test(amount) || Number(amount) <= 0)) {
    throw new EscalationError('decision_not_allowed', 'the budget increase must be above zero');
  }
}

/** True when the escalation's decision allows `action` now (scope and expiry; not the hash). */
export function decisionAllows(escalation: Escalation, action: string, at: Date): boolean {
  const decision = escalation.decision;
  if (escalation.status !== 'resolved' || decision === null) return false;
  const expiresAt = Date.parse(String(decision.expires_at));
  return (
    decision[`allow_${action}`] === true && Number.isFinite(expiresAt) && at.getTime() < expiresAt
  );
}

/**
 * Re-checks a decision just before the protected action (FR-17, Ch.6 §6.6). An expired decision, or
 * one bound to another version, is voided: the escalation goes back to `acknowledged`, its resolve
 * clock starts again, and `escalation.decision_voided` is recorded. An action outside the decision's
 * scope is refused without voiding it.
 */
export async function revalidateEscalationDecision(
  scope: TenantScope,
  input: RevalidateInput,
  deps: EscalationDeps = {},
): Promise<RevalidateResult> {
  const at = now(deps);
  return await scope.transaction(async (tx) => {
    const { row, config } = await lockOpen(tx, input.escalationId);
    if (row.status !== 'resolved' || row.decision === null) {
      return { valid: false, reason: 'not_decided' };
    }
    const expiresAt = Date.parse(String(row.decision.expires_at));
    const reason =
      !Number.isFinite(expiresAt) || at.getTime() >= expiresAt
        ? ('expired' as const)
        : row.decision.subject_sha256 !== input.subjectSha256
          ? ('input_mismatch' as const)
          : undefined;
    if (reason === undefined) {
      return row.decision[`allow_${input.action}`] === true
        ? { valid: true }
        : { valid: false, reason: 'scope_mismatch' };
    }
    const resolveDueAt = deadlineFrom(
      at,
      config.escalation.sla[row.severity].resolve,
      config.escalation.calendar,
    );
    const state = {
      ...clockStateOf(row),
      status: 'acknowledged' as const,
      resolveDueAt,
      resolveOverdueAt: null,
    };
    await tx.escalations.updateState(
      row.id,
      {
        status: 'acknowledged',
        decision: null,
        decidedBy: null,
        decidedAt: null,
        resolveDueAt,
        resolveOverdueAt: null,
        nextCheckAt: nextCheckAt(state),
      },
      at,
    );
    await tx.audit.append({
      action: 'escalation.decision_voided',
      actorType: 'system',
      actorId: null,
      entityId: row.id,
      payload: { code: row.code, reason },
    });
    return { valid: false, reason };
  });
}

/**
 * Closes an escalation once the caller acted on its decision (or it is no longer needed). Closing
 * a closed escalation changes nothing. Nothing changes after close (trigger).
 */
export async function closeEscalation(
  scope: TenantScope,
  input: { readonly escalationId: string; readonly closedBy: EscalationRaiser },
  deps: EscalationDeps = {},
): Promise<Escalation> {
  const at = now(deps);
  return await scope.transaction(async (tx) => {
    const row = await tx.escalations.lockForUpdate(input.escalationId);
    if (!row) throw new EscalationError('not_found', `escalation ${input.escalationId} not found`);
    if (row.status === 'closed') return row;
    const updated = await tx.escalations.updateState(
      row.id,
      { status: 'closed', closedAt: at, nextCheckAt: null },
      at,
    );
    await tx.audit.append({
      action: 'escalation.closed',
      ...(input.closedBy.type === 'human'
        ? { actorType: 'human' as const, actorId: input.closedBy.id }
        : { actorType: 'system' as const, actorId: null }),
      entityId: row.id,
      payload: { code: row.code, status: row.status },
    });
    return updated;
  });
}
