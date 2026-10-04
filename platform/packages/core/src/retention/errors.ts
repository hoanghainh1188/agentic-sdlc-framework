// Refusals of the evidence hold commands (task E05, design/ADR-M51, QUESTIONS #235). Codes only;
// the API and the CLI render them through the message catalog (`api.error.*`). Unknown intents and
// missing roles are `CommandError`s (`intent_not_found`, `forbidden`), as in E02.
export const EVIDENCE_HOLD_ERROR_CODES = [
  /** The intent's evidence is on hold already: release it first. */
  'evidence_hold_exists',
  /** The intent's evidence is not on hold. */
  'evidence_hold_not_found',
] as const;
export type EvidenceHoldErrorCode = (typeof EVIDENCE_HOLD_ERROR_CODES)[number];

export class EvidenceHoldError extends Error {
  override readonly name = 'EvidenceHoldError';

  constructor(
    readonly code: EvidenceHoldErrorCode,
    message: string,
  ) {
    super(message);
  }
}
