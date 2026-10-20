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
  // L05 (ADR-M82): evaluation plans.
  /** The person has no role in `access.eval_roles` of the project (rule M33). */
  'forbidden',
  'plan_not_found',
  /** Another plan of the project has this code. */
  'plan_code_taken',
  /** The plan is archived: it never changes or runs again. */
  'plan_archived',
  /** The plan is paused (its monthly cap is used up). */
  'plan_paused',
  /** The plan got another version since the caller read it. */
  'plan_changed',
  /** The plan has an evaluation that is not final yet. */
  'evaluation_open',
  /** The plan's monthly cap is used up. */
  'monthly_cap_used',
  /** A monthly cap below what the plan already spent this month. */
  'cap_below_spent',
  /** The server does not have this task set version. */
  'task_set_not_found',
  /** A task ID is not in the task set. */
  'task_not_found',
  /** No agent with this key in the register. */
  'agent_not_found',
  /** The agent is not `active`. */
  'agent_not_active',
  /** The agent has no model in the register. */
  'agent_no_model',
  /** A prompt variant's file is not on the project's default branch. */
  'prompt_not_found',
  /** The Git host could not be read: try again later. */
  'git_host_unavailable',
  // L07 (ADR-M85): a project's own evaluation tasks.
  /** No such intent in the project. */
  'intent_not_found',
  /** The intent has no merged pull request (G7 recorded no merge). */
  'intent_not_merged',
  /** The intent has no linked spec. */
  'spec_missing',
  /** The pull request added or changed no test file (`evaluation.tasks.test_globs`). */
  'no_tests',
  /** The pull request changed only test files. */
  'no_planned_files',
  /** The commit before the change cannot be found for sure (ADR-M85 §2.3). */
  'base_unclear',
  /** More than 20 hidden tests or 20 planned files. */
  'too_many_files',
  /** The task card is not on the project's default branch. */
  'card_not_found',
  /** The task card is not valid, or does not match its intent (merge commit, spec, path). */
  'card_invalid',
  /** The task ID belongs to a task of another intent. */
  'task_id_taken',
  /** The task is gone: its card was removed; it never runs again. */
  'task_gone',
  /** The task or its card changed since the caller read it. */
  'task_changed',
  /** Only a task whose check passed is reviewed. */
  'task_not_checked',
  /** A producer of the intent never reviews its task (R029). */
  'producer_cannot_review',
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
