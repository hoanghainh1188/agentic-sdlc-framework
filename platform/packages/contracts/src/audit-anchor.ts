// The audit anchor store (task E05 PR 2, design/ADR-M51 §2.9; D-05 §7.4). Every day the worker
// writes each tenant's latest audit hash to a bucket outside the database (`audit-anchors`, object
// lock COMPLIANCE): if someone with database access rewrites a whole chain, an older anchor still
// shows it. Used only by the worker, with its own identity `worker-anchor`.
//
// - Keys are `<tenant id>/<YYYY-MM-DD>.json`; any other key is refused
//   (`EvidenceError('invalid_input')`). Errors are `EvidenceError` codes, never service text.
// - A key is written once (`If-None-Match: *`). The identity can still put a delete marker on a
//   key and then write a second version (checked live on SeaweedFS 4.48): the reader therefore
//   lists every version and every delete marker, and the caller treats more than one as tampering.

/** One version (or delete marker) of an anchor key. */
export interface AuditAnchorVersion {
  /** `<tenant id>/<YYYY-MM-DD>.json`. */
  readonly key: string;
  readonly versionId: string;
  readonly deleteMarker: boolean;
}

/** The object lock of one stored version. */
export interface AuditAnchorRetention {
  readonly mode: 'COMPLIANCE' | 'GOVERNANCE';
  readonly until: Date;
}

export interface AuditAnchorStore {
  /**
   * Writes a new key. Returns `exists` when the key already has a current version (the 412 of
   * `If-None-Match: *`), else `written` with the new version's ID.
   */
  put(
    key: string,
    content: Buffer,
  ): Promise<
    { readonly outcome: 'written'; readonly versionId: string } | { readonly outcome: 'exists' }
  >;
  /** Every version and delete marker under `<tenant id>/`, in key order (all pages). */
  listVersions(tenantId: string): Promise<readonly AuditAnchorVersion[]>;
  /** One version's bytes; a larger file is refused (`too_large`) before its body is read. */
  get(key: string, versionId: string, maxBytes: number): Promise<Buffer>;
  /** One version's lock, or null when it has none. */
  retention(key: string, versionId: string): Promise<AuditAnchorRetention | null>;
}
