// Escalation module (D-08 B11, D-02 FR-18, handbook Ch.6 §6.4–§6.6, design/ADR-M28).
export {
  advanceEscalation,
  clockStateOf,
  type AdvanceOutcome,
  type AdvanceResult,
} from './advance.js';
export {
  advanceClock,
  initialClocks,
  nextCheckAt,
  stepWindow,
  type ClockEffect,
  type ClockState,
  type InitialClocks,
  type StepWindow,
} from './clock.js';
export { ESCALATION_CODE_PATTERN, formatEscalationCode, parseEscalationCode } from './code.js';
export {
  acknowledgeEscalation,
  actingRoles,
  closeEscalation,
  decideEscalation,
  decisionAllows,
  DEFAULT_DECISION_ACTIONS,
  revalidateEscalationDecision,
  type AcknowledgeInput,
  type DecideInput as EscalationDecideInput,
  type RevalidateInput as EscalationRevalidateInput,
  type RevalidateResult as EscalationRevalidateResult,
} from './decide.js';
export { EscalationError, type EscalationErrorCode } from './errors.js';
export { assertActionAllowed, checkFreeze, isFreezing, type FreezeCheck } from './freeze.js';
export { clockNotices, raisedNotices, type NoticeToRecord } from './notices.js';
export { checkPacket, type EscalationPacket } from './packet.js';
export {
  raiseEscalation,
  type EscalationDeps,
  type EscalationRaiser,
  type RaiseEscalationInput,
} from './raise.js';
export {
  firstStep,
  GOVERNANCE_ROLE,
  holdersFrom,
  isUnrouted,
  pickHolder,
  resolveHolders,
  stepRole,
  type EscalationHolders,
} from './routing.js';
