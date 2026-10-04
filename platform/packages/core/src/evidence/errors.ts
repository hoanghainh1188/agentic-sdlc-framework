// Refusals of the Evidence Builder (task E02, design/ADR-M48). Codes only; the API and the CLI
// render them through the message catalog (`api.error.*`). Unknown intents and missing roles are
// `CommandError`s (`intent_not_found`, `forbidden`), as in E04 and E06.
export const EVIDENCE_PACK_ERROR_CODES = [
  /** The project has no AI record, so no disclosure note can be written (FR-43, FR-19). */
  'ai_record_missing',
  /** A version of the intent's pack is sealed (E03): no new build. */
  'pack_sealed',
  /** No pack, or no such version. */
  'pack_not_found',
  /** The pack's files were purged (E05); the row and the hashes stay. */
  'pack_purged',
  /** A stored file's SHA-256 or size differs from its row: possible tampering (fail closed). */
  'evidence_hash_mismatch',
  /** A stored file is gone from the evidence store (fail closed). */
  'evidence_missing',
  /** A stored file is larger than the per-item cap (`SDLC_API_EVIDENCE_MAX_ITEM_MB`). */
  'evidence_too_large',
  /** The evidence store cannot be reached or refused the credential. */
  'evidence_unavailable',
  /** Concurrent builds kept taking the next version; try again. */
  'pack_conflict',
] as const;
export type EvidencePackErrorCode = (typeof EVIDENCE_PACK_ERROR_CODES)[number];

export class EvidencePackError extends Error {
  override readonly name = 'EvidencePackError';

  constructor(
    readonly code: EvidencePackErrorCode,
    message: string,
  ) {
    super(message);
  }
}
