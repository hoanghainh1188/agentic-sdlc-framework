// Evidence store adapter: S3 API (SeaweedFS). See design/D-03 section 7.5, design/ADR-M33 §2.9.
export { S3EvidenceStore, type S3EvidenceStoreOptions } from './store.js';
export {
  MAX_VERSIONS_PER_KEY,
  S3RetentionStore,
  type S3RetentionStoreOptions,
} from './retention.js';
export {
  AUDIT_ANCHOR_KEY,
  MAX_ANCHOR_VERSIONS,
  S3AuditAnchorStore,
  type S3AuditAnchorStoreOptions,
} from './anchor.js';
