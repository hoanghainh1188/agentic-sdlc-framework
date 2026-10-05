// Audit log: per-tenant hash chain and declared actions (design/D-05 section 7, ADR-M09 §2.8).
export {
  AUDIT_ACTIONS,
  MAX_AUDIT_PAYLOAD_BYTES,
  type AuditAction,
  type AuditActionSpec,
  type AuditFieldKind,
  type AuditFieldSpec,
  type AuditPayload,
} from './actions.js';
export {
  AUDIT_HASH_VERSION,
  GENESIS_HASH,
  INITIAL_CHAIN_STATE,
  recordHash,
  stepChain,
  verifyChain,
  type ChainBreak,
  type ChainBreakReason,
  type ChainRecord,
  type ChainState,
  type StoredChainRecord,
} from './hash-chain.js';
export {
  ANCHOR_MIN_LOCK_DAYS,
  ANCHOR_MISMATCH_REASONS,
  anchorBytes,
  anchorDate,
  anchorKey,
  anchorLockHolds,
  compareAnchor,
  dateOfAnchorKey,
  MAX_ANCHOR_BYTES,
  parseAnchor,
  type AnchorMismatchReason,
  type AuditAnchor,
} from './anchor.js';
export { runAnchorPass, type AnchorPassDeps, type AnchorPassResult } from './anchor-pass.js';
