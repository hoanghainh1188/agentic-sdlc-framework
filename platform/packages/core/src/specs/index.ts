// Spec linking and the spec hash check (task B08, D-02 FR-02, design/ADR-M39).
export { SPEC_ERROR_MESSAGES, SpecError, specErrorMessage, type SpecErrorCode } from './errors.js';
export {
  linkSpecFromGitHost,
  specAccess,
  specLinkable,
  type LinkSpecRequest,
  type SpecAccess,
  type SpecGitHost,
} from './link.js';
export { readSpec, type SpecRead } from './read.js';
export {
  isSpecPath,
  SPEC_EXTENSIONS,
  SPEC_MAX_BYTES,
  SPEC_UNREADABLE_CAUSES,
  specContentSha256,
  type SpecUnreadableCause,
} from './rules.js';
export {
  ACCEPTANCE_CRITERIA_MAX,
  readSpecStructure,
  SPEC_STRUCTURES,
  type SpecStructure,
  type SpecStructureCode,
} from './structure.js';
