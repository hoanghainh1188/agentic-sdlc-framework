// The project AI record (task B12, design/ADR-M32, handbook Ch.2 §2.5, template T7).
export {
  AI_RECORD_ERROR_MESSAGES,
  AiRecordError,
  aiRecordErrorMessage,
  type AiRecordErrorCode,
} from './errors.js';
export { checkAiRecordAtSubmit } from './g1-check.js';
export {
  aiRecordRefusal,
  aiRecordSha256,
  aiRecordViolation,
  CLIENT_DATA_CLASSES,
  consentOf,
  effectiveDataClasses,
  sortDataClasses,
  type AiRecordContent,
  type AiRecordViolation,
} from './rules.js';
export {
  aiRecordAccess,
  aiRecordFacts,
  loadAiRecordFacts,
  saveAiRecord,
  type AiRecordAccess,
} from './service.js';
