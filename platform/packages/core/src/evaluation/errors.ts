// Refusals of the evaluation service (task L04, design/ADR-M81 §2.6). Codes only; the operator
// command and, in L05, the API and the dashboard render them through the message catalog
// (`evaluation.error.*`).
export const EVALUATION_ERROR_CODES = [
  /** The project does not exist for the tenant. */
  'project_not_found',
  /** The project is not `active`. */
  'project_not_active',
  /** `prohibited` data goes to no model, so it is never evaluated (D-07 §4). */
  'data_class_prohibited',
  /** The project has no AI record: the client's consent is unknown (D-02 FR-19). */
  'ai_record_missing',
  /** The project's AI record does not allow this data class. */
  'data_class_not_allowed',
  /** A configuration's model is not allowed for the data class by the project's policy. */
  'model_not_allowed',
  /** `client_restricted` data goes to self-hosted models only (D-07 §4). */
  'self_hosted_only',
  /** An input has a format the evaluation does not accept. */
  'invalid_input',
] as const;
export type EvaluationErrorCode = (typeof EVALUATION_ERROR_CODES)[number];

export class EvaluationError extends Error {
  override readonly name = 'EvaluationError';

  constructor(
    readonly code: EvaluationErrorCode,
    message: string,
  ) {
    super(message);
  }
}
