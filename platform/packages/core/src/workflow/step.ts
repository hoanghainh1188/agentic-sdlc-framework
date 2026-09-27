// One step of the intent workflow (D-08 B07, design/D-03 section 6, design/ADR-M30 §2.4, §2.9).
//
// The Temporal workflow (worker) calls this as an activity in a loop. The database is the source of
// truth: each call reads the intent under its lock and makes at most one move, in one transaction
// with its audit event and its status notice (FR-22). A call repeated after a crash changes
// nothing, because the move is a compare-and-set on the intent's status and gate.
//
// Moves (D-03 section 6):
//   draft → G1 (the submit; B12 adds the AI-record check here) → G2 → G3 → G4 (C06 continues);
//   a rejection at G1–G3 ends the intent as `rejected`; a request for changes keeps it at the gate;
//   HOTL (session 2, QUESTIONS #88): the platform passes G2 or G3 when the policy conditions hold;
//   a person's block within the block window takes the intent back to the passed gate, or ends it.
// A gate that waits for a person past its deadline raises one escalation (session 2, #90); the
// step asks the workflow to wake it at the deadline (`wakeInMs`).
//
// Rules that are not configuration (design, not tunable values):
// - The gate order (D-03 section 6). No gate ever passes by silence: an approval is a person's
//   decision; the registry refuses a system `pass` at a HITL gate. A HOTL pass needs its
//   conditions (hotl.ts) and never repeats on an input a person sent back.
// - A decision counts only when recorded after the intent last entered the gate and after the last
//   request for changes at that gate. The order comes from the audit chain (`seq`), which is exact
//   where the timestamps of concurrent transactions are not.
// - Before every advance: the freeze check (`gate_advance`, ADR-M28 §2.4) and the approval binding
//   (FR-17: `revalidateApprovals` voids an approval that expired or no longer matches the input).
//   Ending the intent or sending it back is never frozen.
// Tunable values come from the project configuration through the policy engine: the oversight mode,
// the roles and the number of approvals per gate and risk tier, the approval expiry, the HOTL block
// window, the gate deadline and the overdue escalation's severity and level.
import type {
  GateCode,
  IntentStepResult,
  OversightResolution,
  PolicyEngine,
  ProjectRole,
  ValidatedProjectConfig,
} from '@sdlc/contracts';

import {
  gateInputSha256,
  intentInputSha256,
  isCommandGate,
  type CommandGate,
} from '../commands/gate-input.js';
import { CommandError } from '../commands/errors.js';
import type { IntentNoticeKind } from '../db/repositories/intent-notices.js';
import type { Intent } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { EscalationError } from '../escalation/errors.js';
import { assertActionAllowed } from '../escalation/freeze.js';
import type { Registry } from '../registry/registry.js';
import { gateHistory, type GateHistory } from './gate-history.js';
import {
  earlierBlock,
  hotlBlockWindowOpenUntil,
  hotlConditionsHold,
  sentBackForInput,
  type EarlierBlock,
} from './hotl.js';
import { checkGateOverdue, closeGateOverdue, gateClockStart } from './overdue.js';

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

/** The project configuration and policy engine in force for this step. */
interface StepPolicy {
  readonly config: ValidatedProjectConfig;
  readonly policy: PolicyEngine;
}

const moved: IntentStepResult = { outcome: 'moved' };

function waiting(
  reason: Extract<IntentStepResult, { outcome: 'waiting' }>['reason'],
  wakeInMs?: number,
): IntentStepResult {
  return wakeInMs === undefined
    ? { outcome: 'waiting', reason }
    : { outcome: 'waiting', reason, wakeInMs };
}

/**
 * Makes at most one move of the intent and says what the workflow does next: step again
 * (`moved`), wait for a wake signal or a timer (`waiting`), or end (`finished`).
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
    const policy = await deps.registry.policyFor(tx, intent.project_id);
    const block = await earlierBlock(tx, intent, policy.config);
    if (block) return sendBack(tx, deps, policy, intent, block);
    const gate = intent.current_gate;
    if (!isCommandGate(gate)) {
      // G4 onwards: C06 continues. Wake when the last HOTL block window closes (C06 waits for it).
      const until = await hotlBlockWindowOpenUntil(tx, deps.registry, intent.id);
      return waiting('later_gate', untilMs(deps, until));
    }
    return stepGate(tx, deps, policy, intent, gate);
  });
}

/** Draft → G1. Creating the intent is the submit (QUESTIONS #89). */
async function submit(tx: TenantScope, deps: StepDeps, intent: Intent): Promise<IntentStepResult> {
  // B12 adds the project AI record check here (FR-19): G1 fails without it.
  if (!(await gateAdvanceAllowed(tx, intent, deps.registry.now()))) return waiting('frozen');
  const policy = await deps.registry.policyFor(tx, intent.project_id);
  return move(tx, deps, policy, intent, { status: 'in_gate', gate: 'G1' }, 'submitted', null);
}

/**
 * A person blocked an earlier gate within its HOTL block window: a request for changes takes the
 * intent back to that gate, a rejection ends it. Never frozen: it stops work, it does not advance.
 */
async function sendBack(
  tx: TenantScope,
  deps: StepDeps,
  policy: StepPolicy,
  intent: Intent,
  block: EarlierBlock,
): Promise<IntentStepResult> {
  const current = intent.current_gate;
  if (current !== null && isCommandGate(current)) {
    await closeGateOverdue(tx, deps.registry, intent.id, current);
  }
  return block.decision === 'reject'
    ? move(
        tx,
        deps,
        policy,
        intent,
        { status: 'rejected', gate: block.gate },
        'rejected',
        block.decisionId,
      )
    : move(
        tx,
        deps,
        policy,
        intent,
        { status: 'in_gate', gate: block.gate },
        'returned',
        block.decisionId,
      );
}

async function stepGate(
  tx: TenantScope,
  deps: StepDeps,
  policy: StepPolicy,
  intent: Intent,
  gate: CommandGate,
): Promise<IntentStepResult> {
  const { registry } = deps;
  const history = await gateHistory(tx, intent.id, gate);

  // A rejection ends the intent. Ending it is never frozen (ADR-M28 §2.7: cancelling is allowed).
  if (history.rejection !== null) {
    await closeGateOverdue(tx, registry, intent.id, gate);
    return move(
      tx,
      deps,
      policy,
      intent,
      { status: 'rejected', gate },
      'rejected',
      history.rejection,
    );
  }
  if (history.latestChangesRequest && !(await announced(tx, history))) {
    // A person decided the gate: the overdue escalation closes, and the gate clock starts again.
    await closeGateOverdue(tx, registry, intent.id, gate);
    await tx.intentNotices.record({
      intentId: intent.id,
      kind: 'changes_requested',
      status: intent.status,
      gate,
      previousGate: null,
      decisionId: history.latestChangesRequest,
      audienceRoles: await nextActors(tx, policy, intent, gate),
    });
  }

  const oversight = await resolveOversight(tx, policy, intent, gate);
  const clockStart = gateClockStart(intent, history.latestChangesRequestAt);
  const overdue = (subject: { kind: 'intent' | 'spec' | 'plan'; sha256: string }) =>
    checkGateOverdue(tx, registry, {
      intent,
      gate,
      config: policy.config,
      oversight,
      clockStart,
      subject,
    });

  let inputSha256: string;
  try {
    inputSha256 = await gateInputSha256(tx, intent, gate);
  } catch (error) {
    if (error instanceof CommandError && error.code === 'gate_input_missing') {
      // The gate waits for a person to link the spec or submit the plan: the deadline runs.
      return waiting(
        'input_missing',
        await overdue({ kind: 'intent', sha256: intentInputSha256(intent) }),
      );
    }
    throw error;
  }
  // FR-17: an approval that expired or no longer matches the input is voided before it counts.
  const { valid } = await registry.revalidateApprovals(tx, {
    intentId: intent.id,
    gate,
    inputSha256,
  });
  const approvals = valid.filter((a) => history.countedApprovals.has(a.id));
  if (approvals.length >= approvalsNeeded(oversight)) {
    await closeGateOverdue(tx, registry, intent.id, gate);
    if (!(await gateAdvanceAllowed(tx, intent, registry.now()))) return waiting('frozen');
    const last = approvals.at(-1)!;
    return move(
      tx,
      deps,
      policy,
      intent,
      { status: 'in_gate', gate: NEXT_GATE[gate]! },
      'advanced',
      last.id,
    );
  }

  // HOTL (QUESTIONS #88, option A): the platform passes the gate when its conditions hold.
  if (
    oversight.mode === 'HOTL' &&
    (await hotlConditionsHold(tx, intent, gate)) &&
    !(await sentBackForInput(tx, intent.id, gate, inputSha256))
  ) {
    await closeGateOverdue(tx, registry, intent.id, gate);
    if (!(await gateAdvanceAllowed(tx, intent, registry.now()))) return waiting('frozen');
    const pass = await registry.decide(tx, {
      intentId: intent.id,
      gate,
      decision: 'pass',
      actor: { type: 'system' },
      inputSha256,
      waitedSeconds: waitedSeconds(intent, registry.now()),
      source: 'workflow',
    });
    return move(
      tx,
      deps,
      policy,
      intent,
      { status: 'in_gate', gate: NEXT_GATE[gate]! },
      'hotl_passed',
      pass.id,
    );
  }

  const subjectKind = gate === 'G1' ? 'intent' : gate === 'G2' ? 'spec' : 'plan';
  return waiting('decision', await overdue({ kind: subjectKind, sha256: inputSha256 }));
}

/**
 * Approvals from different people that the gate needs to move on a person's decision: HITL the
 * matrix count (dual approval included), HOTL one explicit approval. At least one: a person
 * decides. AUDIT or POLICY cannot be decided by a person at G1–G3: the gate waits.
 */
function approvalsNeeded(oversight: OversightResolution): number {
  if (oversight.mode === 'HITL') return Math.max(1, oversight.approvalsNeeded);
  if (oversight.mode === 'HOTL') return 1;
  return Number.POSITIVE_INFINITY;
}

/** Seconds the intent has waited at its gate (FR-12): from the entry, wall-clock time. */
export function waitedSeconds(intent: Pick<Intent, 'gate_entered_at'>, at: Date): number | null {
  if (intent.gate_entered_at === null) return null;
  return Math.max(
    0,
    Math.floor((at.getTime() - new Date(intent.gate_entered_at).getTime()) / 1000),
  );
}

async function resolveOversight(
  tx: TenantScope,
  policy: StepPolicy,
  intent: Intent,
  gate: GateCode,
): Promise<OversightResolution> {
  const plan = await tx.plans.latest(intent.id);
  return policy.policy.oversightMode({
    gate,
    riskTier: intent.risk_tier,
    changeFlags: plan?.change_flags ?? [],
  });
}

/** The roles that act next at `gate`: the gate's approvers or the people it notifies. */
async function nextActors(
  tx: TenantScope,
  policy: StepPolicy,
  intent: Intent,
  gate: GateCode,
): Promise<ProjectRole[]> {
  const oversight = await resolveOversight(tx, policy, intent, gate);
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

function untilMs(deps: StepDeps, until: Date | null): number | undefined {
  return until === null ? undefined : Math.max(0, until.getTime() - deps.registry.now().getTime());
}

/**
 * The roles a notice mentions. HOTL pass: the people the passed gate tells (they may block it)
 * and the next gate's actors. A return: the actors of the gate the intent went back to.
 */
async function audienceFor(
  tx: TenantScope,
  policy: StepPolicy,
  intent: Intent,
  to: { readonly status: 'in_gate' | 'rejected'; readonly gate: GateCode },
  kind: IntentNoticeKind,
  passedGate: GateCode | null,
): Promise<ProjectRole[]> {
  if (to.status !== 'in_gate') return [];
  const roles = isCommandGate(to.gate) ? await nextActors(tx, policy, intent, to.gate) : [];
  if (kind === 'hotl_passed' && passedGate !== null) {
    roles.push(...(await nextActors(tx, policy, intent, passedGate)));
  }
  return [...new Set(roles)];
}

async function move(
  tx: TenantScope,
  deps: StepDeps,
  policy: StepPolicy,
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
    audienceRoles: await audienceFor(tx, policy, updated, to, kind, intent.current_gate),
  });
  return moved;
}
