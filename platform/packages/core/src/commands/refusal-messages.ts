// Texts of the refusal reasons of the policy engine and the registry (NFR-08, ADR-M18). Shared by
// the API error envelope (B03) and the comment replies of the GitHub poller (B06, ADR-M27), so a
// person reads the same sentence in both places.
import type { ApprovalRefusal } from '@sdlc/contracts';
import { t, type MessageKey } from '@sdlc/messages';

import type { DecisionViolation } from '../registry/decision-rules.js';

export type RefusalReason = ApprovalRefusal | DecisionViolation;

/** Catalog keys of the refusal reasons (`gate.reason.<code>`). */
export const REFUSAL_REASON_KEYS: Readonly<Record<RefusalReason, MessageKey>> = {
  actor_not_human: 'gate.reason.actor_not_human',
  producer: 'gate.reason.producer',
  no_human_decision: 'gate.reason.no_human_decision',
  role_missing: 'gate.reason.role_missing',
  already_approved: 'gate.reason.already_approved',
  role_already_covered: 'gate.reason.role_already_covered',
  approvals_complete: 'gate.reason.approvals_complete',
  agent_never_decides: 'gate.reason.agent_never_decides',
  decision_not_for_actor: 'gate.reason.decision_not_for_actor',
  reason_required: 'gate.reason.reason_required',
  hitl_needs_a_person: 'gate.reason.hitl_needs_a_person',
  breach_never_passes: 'gate.reason.breach_never_passes',
};

export function isRefusalReason(reason: string): reason is RefusalReason {
  return Object.hasOwn(REFUSAL_REASON_KEYS, reason);
}

/** Catalog text of a refusal reason; the code itself for a reason without a key. */
export function refusalReasonMessage(reason: string, locale?: string): string {
  return isRefusalReason(reason) ? t(REFUSAL_REASON_KEYS[reason], {}, locale) : reason;
}
