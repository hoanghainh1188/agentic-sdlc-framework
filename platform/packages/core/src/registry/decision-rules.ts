// Rules for every gate decision, checked before the database sees it (D-08 B02). The database
// repeats the structural ones as CHECK constraints (migration 0003).
//
// These are not configuration: they come from D-02 FR-11, design/D-03 section 6 ("no gate is ever
// auto-approved by silence") and design/QUESTIONS.md #6 and #21. The values that tune oversight
// (matrix, roles, expiry) come from the project configuration through the policy engine.
import type {
  ActorType,
  GateCheckMode,
  GateCode,
  GateContext,
  GateDecision,
  GateReasonCode,
} from '@sdlc/contracts';

export const HUMAN_DECISIONS = ['approve', 'reject', 'request_changes', 'pause', 'block'] as const;
export type HumanDecision = (typeof HUMAN_DECISIONS)[number];

/** `void` is written only by `revalidateApprovals`, never as a plain decision. */
export const SYSTEM_DECISIONS = ['pass', 'fail', 'block', 'pause'] as const;
export type SystemDecision = (typeof SYSTEM_DECISIONS)[number];

/** Decisions that need a `reason_code` (D-05 section 6.3, ADR-M20). */
export const REASON_REQUIRED: readonly GateDecision[] = [
  'reject',
  'request_changes',
  'block',
  'fail',
  'void',
];

export type DecisionViolation =
  /** D-02 FR-11: agents never decide or approve. */
  | 'agent_never_decides'
  /** The decision does not belong to this kind of actor. */
  | 'decision_not_for_actor'
  | 'reason_required'
  /** POLICY and AUDIT gates have no human approval step; POLICY gates have no human decision. */
  | 'no_human_decision'
  /** The actor holds none of the gate's roles. */
  | 'role_missing'
  /** A HITL gate never passes without a person (D-03 section 6: no approval by silence). */
  | 'hitl_needs_a_person'
  /** QUESTIONS #21: a G5 breach always stops the run; it never passes, at any risk tier. */
  | 'breach_never_passes';

export interface DecisionFacts {
  readonly gate: GateCode;
  readonly decision: GateDecision;
  readonly actorType: ActorType;
  readonly mode: GateCheckMode;
  readonly reasonCode: GateReasonCode | null;
  readonly context?: GateContext;
}

/** Returns the first rule the decision breaks, or null. */
export function decisionViolation(facts: DecisionFacts): DecisionViolation | null {
  const { actorType, decision, mode } = facts;
  if (actorType === 'agent') return 'agent_never_decides';
  const allowed: readonly GateDecision[] =
    actorType === 'human' ? HUMAN_DECISIONS : SYSTEM_DECISIONS;
  if (!allowed.includes(decision)) return 'decision_not_for_actor';
  if (REASON_REQUIRED.includes(decision) && facts.reasonCode === null) return 'reason_required';
  if (actorType === 'human') {
    if (mode === 'POLICY') return 'no_human_decision';
    if (decision === 'approve' && mode === 'AUDIT') return 'no_human_decision';
    return null;
  }
  if (decision === 'pass') {
    // A breach at G5 is never passed, even where the matrix gives HOTL (Low, Medium).
    if (facts.gate === 'G5' && facts.context?.breached === true) return 'breach_never_passes';
    if (mode === 'HITL') return 'hitl_needs_a_person';
  }
  return null;
}
