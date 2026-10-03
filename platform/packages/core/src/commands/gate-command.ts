// One handler for gate decisions from people: the API (task B03) and, later, comment commands
// (B06) and the workflow signal (B07) (ADR-M26 section 2.4, QUESTIONS.md #64).
// It records the decision only. Moving the intent to the next gate is the workflow's job (B07,
// ADR-M30): the caller wakes the intent's workflow after the commit.
import type { EventSource, GateReasonCode, UserId } from '@sdlc/contracts';

import type { GateDecisionRow, Intent } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { normalizeScope, type ApprovalScope } from '../registry/approval-binding.js';
import type { HumanDecision } from '../registry/decision-rules.js';
import type { Registry } from '../registry/registry.js';
import { refusedPlanHashes, returnedFromG5 } from '../workflow/g5-scope.js';
import { isPassableGate, openBlockWindow } from '../workflow/hotl.js';
import { waitedSeconds } from '../workflow/waited.js';
import { projectAccess } from './access.js';
import { CommandError } from './errors.js';
import { gateInputSha256, isDecidableGate } from './gate-input.js';

/** Decisions a person may send as a command (D-08 B03 AC3, B06 AC2). */
export const COMMAND_DECISIONS = [
  'approve',
  'reject',
  'request_changes',
] as const satisfies readonly HumanDecision[];
export type CommandDecision = (typeof COMMAND_DECISIONS)[number];

export interface GateCommand {
  readonly intent: Intent;
  readonly gate: string;
  readonly decision: CommandDecision;
  readonly actorId: UserId;
  readonly reasonCode?: GateReasonCode | null;
  readonly reasonRef?: string | null;
  readonly scope?: ApprovalScope | null;
  readonly source: 'cli' | 'github_comment' | 'github_review';
  readonly eventSource?: EventSource | null;
}

/**
 * Checks that the actor can see the intent's project (no role → `intent_not_found`, so an
 * outsider learns nothing), binds the decision to the gate's input and records it through the
 * registry, which resolves the oversight mode and checks the approver with the policy engine.
 * At G1–G3 there is no produced change yet, so the producer list is empty (QUESTIONS.md #64).
 * At G4 the run does not exist yet. At G5 (C07) the person who allowed the run (`triggered_by`,
 * the G4 approver) produced its changes with the agent and never decides them (FR-11).
 */
export async function decideGate(
  registry: Registry,
  scope: TenantScope,
  command: GateCommand,
): Promise<GateDecisionRow> {
  const { intent } = command;
  const access = await projectAccess(scope, intent.project_id, command.actorId);
  if (access.roles.length === 0) {
    throw new CommandError('intent_not_found', `intent ${intent.code} not found`);
  }
  if (!isDecidableGate(command.gate)) {
    throw new CommandError('gate_not_supported', `${command.gate} cannot be decided by a command`);
  }
  const gate = command.gate;
  // D3 (B07 session 2): the gate advance at G1–G3 has no scope, nor the run start at G4 (C06), so an approval with one is refused
  // here instead of being recorded and then voided (`scope_mismatch`, which stays as a safeguard).
  if (command.decision === 'approve' && normalizeScope(command.scope) !== null) {
    throw new CommandError('scope_not_allowed', `${gate} approvals take no scope`);
  }
  // The workflow counts decisions only for the gate the intent waits at (B07, ADR-M30 §2.4), with
  // one exception: within its HOTL block window, a gate the platform passed may still be rejected
  // or sent back although the intent waits at a later gate (QUESTIONS #88, ADR-M30 §2.4b).
  // Checked on the intent read under its lock, in the transaction of the decision: the workflow
  // cannot move the intent between the check and the record.
  return scope.transaction(async (tx) => {
    const current = await tx.intents.lockAndGet(intent.id);
    if (!current) throw new CommandError('intent_not_found', `intent ${intent.code} not found`);
    const now = registry.now();
    const atGate = current.status === 'in_gate' && current.current_gate === gate;
    if (!atGate && !(await mayBlockPassedGate(registry, tx, current, gate, command, now))) {
      throw new CommandError(
        'gate_not_current',
        `${current.code} is not waiting at ${gate} (${current.status}, ${String(current.current_gate)})`,
      );
    }
    const inputSha256 = await gateInputSha256(tx, current, gate);
    // C07 (QUESTIONS #131): after a run went outside its plan, G3 is HITL and needs a new plan.
    const returned = gate === 'G3' && (await returnedFromG5(tx, current.id));
    if (
      returned &&
      command.decision === 'approve' &&
      (await refusedPlanHashes(tx, current.id)).has(inputSha256)
    ) {
      throw new CommandError('plan_refused', `${current.code}: a run went outside this plan`);
    }
    return registry.decide(tx, {
      intentId: current.id,
      gate: gate,
      decision: command.decision,
      actor: { type: 'human', id: command.actorId },
      producers: gate === 'G5' ? await runProducers(tx, current.id) : [],
      inputSha256,
      reasonCode: command.reasonCode ?? null,
      reasonRef: command.reasonRef ?? null,
      ...(command.decision === 'approve' ? { scope: command.scope ?? null } : {}),
      // FR-12: the time the gate waited for this person; none for a block of a passed gate.
      waitedSeconds: atGate ? waitedSeconds(current, now) : null,
      source: command.source,
      eventSource: command.eventSource ?? null,
      ...(returned ? { context: { returnedFromG5: true } } : {}),
    });
  });
}

/** The producers of the intent's last run: the person who allowed it, when any (C07, FR-11). */
async function runProducers(tx: TenantScope, intentId: string): Promise<string[]> {
  const run = (await tx.runs.listForIntent(intentId)).at(-1);
  return run?.triggered_by ? [run.triggered_by] : [];
}

/** A rejection or request for changes of a gate the platform passed, within its block window. */
async function mayBlockPassedGate(
  registry: Registry,
  tx: TenantScope,
  intent: Intent,
  gate: string,
  command: GateCommand,
  now: Date,
): Promise<boolean> {
  if (command.decision === 'approve' || intent.status !== 'in_gate') return false;
  if (!isPassableGate(gate)) return false;
  const { config } = await registry.policyFor(tx, intent.project_id);
  return (await openBlockWindow(tx, intent, gate, config, now)) !== null;
}
