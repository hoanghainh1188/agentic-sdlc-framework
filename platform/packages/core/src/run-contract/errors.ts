// Refusals when issuing a Run Contract (D-08 C02, ADR-M22). Like `DbError`, they carry a stable
// `code`; the API and CLI turn codes into user-facing text through the message catalog (NFR-08).
// A contract refused by the runner is not an error: `verifyRunContract` returns a reject reason.

export type RunContractErrorCode =
  /** No intent with this ID in the tenant. */
  | 'intent_not_found'
  /** The intent is done, rejected, cancelled or blocked: no new runs. */
  | 'intent_closed'
  /** The plan is not the intent's latest plan (a newer plan needs G3 again). */
  | 'plan_not_latest'
  /** The requested autonomy is above the intent's `max_autonomy`. */
  | 'autonomy_above_intent'
  /** An input does not fit the Run Contract schema; `field` says which. */
  | 'invalid_input'
  /** The signing service returned a signature that does not match the contract. */
  | 'signature_invalid';

export class RunContractError extends Error {
  override readonly name = 'RunContractError';

  constructor(
    readonly code: RunContractErrorCode,
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}
