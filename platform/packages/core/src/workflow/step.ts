// One step of the intent workflow (D-08 B07 AC1, design/D-03 section 6, design/ADR-M30 §2.4).
//
// The Temporal workflow (worker) calls this as an activity in a loop. The database is the source of
// truth: each call reads the intent under its lock and makes at most one move, in one transaction
// with its audit event and its status notice (FR-22). A call repeated after a crash changes
// nothing, because the move is a compare-and-set on the intent's status and gate.
//
// Session 1 of B07 covers the moves of the D-03 state machine on people's decisions:
//   draft → G1 (the submit, after the project AI record check of B12) → G2 → G3 → G4 (C06 continues);
//   a rejection at G1–G3 ends the intent as `rejected`; a request for changes keeps it at the gate.
// Session 2 adds the HOTL pass, the gate deadline and the escalation of an overdue gate.
//
// Rules that are not configuration (design, not tunable values):
// - The gate order (D-03 section 6). No gate ever passes by silence: an approval is a person's
//   decision; the registry refuses a system `pass` at a HITL gate.
// - A decision counts only when recorded after the intent last entered the gate and after the last
//   request for changes at that gate. The order comes from the audit chain (`seq`), which is exact
//   where the timestamps of concurrent transactions are not.
// - Before every move: the freeze check (`gate_advance`, ADR-M28 §2.4) and the approval binding
//   (FR-17: `revalidateApprovals` voids an approval that expired or no longer matches the input).
// Tunable values come from the project configuration through the policy engine: the oversight mode,
// the roles and the number of approvals per gate and risk tier, the approval expiry.
import type { GateCode, IntentStepResult, ProjectRole } from '@sdlc/contracts';

import { checkAiRecordAtSubmit } from '../ai-record/g1-check.js';
import { gateInputSha256, isCommandGate } from '../commands/gate-input.js';
import { CommandError } from '../commands/errors.js';
import type { IntentNoticeKind } from '../db/repositories/intent-notices.js';
import type { Intent } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { EscalationError } from '../escalation/errors.js';
import { assertActionAllowed } from '../escalation/freeze.js';
import type { Registry } from '../registry/registry.js';
import { gateHistory, type GateHistory } from './gate-history.js';

/** Statuses in which the intent is finished: the workflow ends. */
export const FINISHED_INTENT_STATUSES = ['done', 'rejected', 'cancelled'] as const;

/** The gates the workflow moves on people's decisions (B07); G4 onwards come with C06 and later. */
const NEXT_GATE: Readonly<Partial<Record<GateCode, GateCode>>> = { G1: 'G2', G2: 'G3', G3: 'G4' };

export interface StepDeps {
  /** The registry with the apps' policy factory; its clock is the workflow's clock. */
  readonly registry: Registry;
}

export class WorkflowError extends Error {
  override readonly name = 'WorkflowError';

  constructor(
    readonly code: 'intent_not_found',
    message: string,
  ) {
    super(message);
  }
}

const moved: IntentStepResult = { outcome: 'moved' };
const waiting = (reason: Extract<IntentStepResult, { outcome: 'waiting' }>['reason']) =>
  ({ outcome: 'waiting', reason }) as const;

/**
 * Makes at most one move of the intent and says what the workflow does next: step again
 * (`moved`), wait for a wake signal (`waiting`), or end (`finished`).
 */
export async function stepIntent(
  scope: TenantScope,
  deps: StepDeps,
  intentId: string,
): Promise<IntentStepResult> {
  return scope.transaction(async (tx) => {
    const intent = await tx.intents.lockAndGet(intentId);
    if (!intent) throw new WorkflowError('intent_not_found', `intent ${intentId} not found`);
    if ((FINISHED_INTENT_STATUSES as readonly string[]).includes(intent.status)) {
      return { outcome: 'finished', status: intent.status };
    }
    if (intent.status === 'draft') return submit(tx, deps, intent);
    if (intent.status !== 'in_gate' || intent.current_gate === null) return waiting('not_in_gate');
    const gate = intent.current_gate;
    if (!isCommandGate(gate)) return waiting('later_gate');
    return stepGate(tx, deps, intent, gate);
  });
}

/** Draft → G1. Creating the intent is the submit (QUESTIONS #89). */
async function submit(tx: TenantScope, deps: StepDeps, intent: Intent): Promise<IntentStepResult> {
  // FR-19 (B12, ADR-M32 §2.5): no G1 without a project AI record that allows the data class.
  if (await checkAiRecordAtSubmit(tx, deps.registry, intent)) return waiting('ai_record');
  if (!(await gateAdvanceAllowed(tx, intent, deps.registry.now()))) return waiting('frozen');
  return move(tx, deps, intent, { status: 'in_gate', gate: 'G1' }, 'submitted', null);
}

async function stepGate(
  tx: TenantScope,
  deps: StepDeps,
  intent: Intent,
  gate: 'G1' | 'G2' | 'G3',
): Promise<IntentStepResult> {
  const history = await gateHistory(tx, intent.id, gate);

  // A rejection ends the intent. Ending it is never frozen (ADR-M28 §2.7: cancelling is allowed).
  if (history.rejection !== null) {
    return move(tx, deps, intent, { status: 'rejected', gate }, 'rejected', history.rejection);
  }
  if (history.latestChangesRequest && !(await announced(tx, history))) {
    await tx.intentNotices.record({
      intentId: intent.id,
      kind: 'changes_requested',
      status: intent.status,
      gate,
      previousGate: null,
      decisionId: history.latestChangesRequest,
      audienceRoles: await nextActors(tx, deps, intent, gate),
    });
  }

  let inputSha256: string;
  try {
    inputSha256 = await gateInputSha256(tx, intent, gate);
  } catch (error) {
    if (error instanceof CommandError && error.code === 'gate_input_missing') {
      return waiting('input_missing');
    }
    throw error;
  }
  // FR-17: an approval that expired or no longer matches the input is voided before it counts.
  const { valid } = await deps.registry.revalidateApprovals(tx, {
    intentId: intent.id,
    gate,
    inputSha256,
  });
  const approvals = valid.filter((a) => history.countedApprovals.has(a.id));
  if (approvals.length < (await approvalsNeeded(tx, deps, intent, gate))) {
    return waiting('decision');
  }
  if (!(await gateAdvanceAllowed(tx, intent, deps.registry.now()))) return waiting('frozen');
  const next = NEXT_GATE[gate]!;
  const last = approvals.at(-1)!;
  return move(tx, deps, intent, { status: 'in_gate', gate: next }, 'advanced', last.id);
}

/** Approvals from different people that the gate needs: at least one (a person decides). */
async function approvalsNeeded(
  tx: TenantScope,
  deps: StepDeps,
  intent: Intent,
  gate: GateCode,
): Promise<number> {
  const oversight = await resolveOversight(tx, deps, intent, gate);
  // HOTL: session 1 waits for an explicit approval; the HOTL pass comes in session 2 (#88).
  // AUDIT or POLICY cannot be decided by a person at G1–G3: the gate waits (config never sets it).
  return oversight.mode === 'HITL' || oversight.mode === 'HOTL'
    ? Math.max(1, oversight.approvalsNeeded)
    : Number.POSITIVE_INFINITY;
}

async function resolveOversight(tx: TenantScope, deps: StepDeps, intent: Intent, gate: GateCode) {
  const { policy } = await deps.registry.policyFor(tx, intent.project_id);
  const plan = await tx.plans.latest(intent.id);
  return policy.oversightMode({
    gate,
    riskTier: intent.risk_tier,
    changeFlags: plan?.change_flags ?? [],
  });
}

/** The roles that act next at `gate`: the gate's approvers or the people it notifies. */
async function nextActors(
  tx: TenantScope,
  deps: StepDeps,
  intent: Intent,
  gate: GateCode,
): Promise<ProjectRole[]> {
  const oversight = await resolveOversight(tx, deps, intent, gate);
  return oversight.roles.filter((role) => role !== 'viewer');
}

async function announced(tx: TenantScope, history: GateHistory): Promise<boolean> {
  return history.latestChangesRequest !== null
    ? tx.intentNotices.existsForDecision(history.latestChangesRequest)
    : true;
}

/** The freeze check before a move (ADR-M28 §2.4). A frozen intent waits; it never fails. */
async function gateAdvanceAllowed(tx: TenantScope, intent: Intent, at: Date): Promise<boolean> {
  try {
    await assertActionAllowed(tx, intent.id, 'gate_advance', at);
    return true;
  } catch (error) {
    if (error instanceof EscalationError && error.code === 'frozen') return false;
    throw error;
  }
}

async function move(
  tx: TenantScope,
  deps: StepDeps,
  intent: Intent,
  to: { readonly status: 'in_gate' | 'rejected'; readonly gate: GateCode },
  kind: IntentNoticeKind,
  decisionId: string | null,
): Promise<IntentStepResult> {
  const updated = await tx.intents.moveState(intent.id, {
    from: { status: intent.status, currentGate: intent.current_gate },
    to: { status: to.status, currentGate: to.gate },
    at: deps.registry.now(),
  });
  // Under the intent lock the compare-and-set cannot miss; if it does, read the state again.
  if (!updated) return moved;
  await tx.intentNotices.record({
    intentId: intent.id,
    kind,
    status: updated.status,
    gate: updated.current_gate,
    previousGate: intent.current_gate,
    decisionId,
    audienceRoles:
      to.status === 'in_gate' && isCommandGate(to.gate)
        ? await nextActors(tx, deps, updated, to.gate)
        : [],
  });
  return moved;
}
