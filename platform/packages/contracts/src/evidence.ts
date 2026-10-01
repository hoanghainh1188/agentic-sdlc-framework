// The evidence store (design/D-03 section 7.5; first user: task C06 session 2b, ADR-M33 §2.9).
// The MVP stores evidence files in SeaweedFS through its S3 API (`@sdlc/adapter-evidence-s3`).
//
// Evidence is never overwritten: `put` refuses a path that exists (`EvidenceError('exists')`), so
// one path holds one version. The SHA-256 returned by `put` is computed by the caller's process
// from the bytes it sent; E02 checks it again when it reads the file for the Evidence Pack.

/** Kinds of evidence file (design/D-05 section 6.6 `evidence_items.kind`). */
export const EVIDENCE_KINDS = [
  'spec',
  'plan',
  'proposal',
  'diff',
  'ci_result',
  'test_report',
  'scan_report',
  'review',
  'cost_summary',
  'disclosure_note',
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export interface StoredEvidence {
  /** `s3://<bucket>/<key>`: stored in `evidence_items.storage_uri`. */
  readonly uri: string;
  /** SHA-256 (hex) of the bytes sent. */
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface EvidenceStore {
  /**
   * Stores a new file for a tenant at `path` (relative, `/`-separated). Throws
   * `EvidenceError('exists')` when the path is taken: evidence is never overwritten.
   */
  put(
    tenantId: string,
    path: string,
    content: Buffer,
    contentType: string,
  ): Promise<StoredEvidence>;
  /** Reads a file back by its URI (needs a credential that may read; the runner's may not). */
  get(uri: string): Promise<Buffer>;
}

export const EVIDENCE_ERROR_CODES = [
  'invalid_input',
  'exists',
  'forbidden',
  'not_found',
  'unavailable',
] as const;
export type EvidenceErrorCode = (typeof EVIDENCE_ERROR_CODES)[number];

/** Why an evidence call failed. A code only: never text from the storage service. */
export class EvidenceError extends Error {
  override readonly name = 'EvidenceError';

  constructor(readonly code: EvidenceErrorCode) {
    super(`evidence.${code}`);
  }
}
