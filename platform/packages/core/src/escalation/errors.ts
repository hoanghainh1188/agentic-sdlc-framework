// Refusals of the escalation module (task B11, design/ADR-M28). Like `RegistryError`, they carry a
// stable `code`; the API and the comment handler render codes through the message catalog.
export type EscalationErrorCode =
  /** No escalation, or no intent, with this ID in the tenant. */
  | 'not_found'
  /** The intent is done, rejected or cancelled: nothing to escalate. */
  | 'intent_not_open'
  /** The decision packet has an undeclared field or a value in the wrong format. */
  | 'invalid_packet'
  /** A G5 breach needs at least response level `pause` (QUESTIONS #21, ADR-M28 §2.6). */
  | 'response_level_too_low'
  /** An open escalation freezes the intent and the action is not on the safe list (#76). */
  | 'frozen';

export class EscalationError extends Error {
  override readonly name = 'EscalationError';

  constructor(
    readonly code: EscalationErrorCode,
    message: string,
    /** Codes of the escalations that freeze the intent (`frozen` only). */
    readonly escalationCodes: readonly string[] = [],
  ) {
    super(message);
  }
}
