// Run events: declared, coded payloads only (design/D-05 section 6.4, ADR-M22 section 2.5).
export {
  checkRunEvent,
  isRunEventType,
  MAX_RUN_EVENT_PAYLOAD_BYTES,
  RUN_EVENT_TYPES,
  type RunEventFieldKind,
  type RunEventFieldSpec,
  type RunEventPayload,
  type RunEventType,
} from './types.js';
export { recordBudgetWarning, type BudgetWarning } from './budget-warning.js';
