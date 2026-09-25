// Intent / spec registry and gate decisions (design/D-03 section 5.2, D-08 B02, ADR-M20).
export {
  checkApprovalBinding,
  normalizeScope,
  scopesEqual,
  type ApprovalScope,
  type BindingStatus,
  type BoundApproval,
  type CurrentInput,
} from './approval-binding.js';
export {
  decisionViolation,
  HUMAN_DECISIONS,
  REASON_REQUIRED,
  SYSTEM_DECISIONS,
  type DecisionFacts,
  type DecisionViolation,
  type HumanDecision,
  type SystemDecision,
} from './decision-rules.js';
export {
  loadEffectiveConfig,
  type EffectiveConfig,
  type PolicyFactory,
  type RegistryDeps,
} from './effective-config.js';
export { RegistryError, type RegistryErrorCode } from './errors.js';
export {
  formatIntentCode,
  INTENT_CODE_PATTERN,
  intentCodeYear,
  parseIntentCode,
} from './intent-code.js';
export { Registry } from './registry.js';
