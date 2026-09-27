// One handler for gate decisions from people: the API (task B03) and, later, comment commands
// (B06) and the workflow signal (B07) (ADR-M26 section 2.4, QUESTIONS.md #64).
// B03 records the decision only. Moving the intent to the next gate is the workflow's job (B07).
import type { EventSource, GateReasonCode, UserId } from '@sdlc/contracts';

import type { GateDecisionRow, Intent } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import type { ApprovalScope } from '../registry/approval-binding.js';
import type { HumanDecision } from '../registry/decision-rules.js';
import type { Registry } from '../registry/registry.js';
import { projectAccess } from './access.js';
import { CommandError } from './errors.js';
import { gateInputSha256, isCommandGate } from './gate-input.js';

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
  if (!isCommandGate(command.gate)) {
    throw new CommandError('gate_not_supported', `${command.gate} cannot be decided by a command`);
  }
  const inputSha256 = await gateInputSha256(scope, intent, command.gate);
  return registry.decide(scope, {
    intentId: intent.id,
    gate: command.gate,
    decision: command.decision,
    actor: { type: 'human', id: command.actorId },
    producers: [],
    inputSha256,
    reasonCode: command.reasonCode ?? null,
    reasonRef: command.reasonRef ?? null,
    ...(command.decision === 'approve' ? { scope: command.scope ?? null } : {}),
    source: command.source,
    eventSource: command.eventSource ?? null,
  });
}
