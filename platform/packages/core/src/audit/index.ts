// Audit log: per-tenant hash chain and declared actions (design/D-05 section 7, ADR-M09 §2.8).
export {
  AUDIT_ACTIONS,
  MAX_AUDIT_PAYLOAD_BYTES,
  type AuditAction,
  type AuditActionSpec,
  type AuditFieldKind,
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
