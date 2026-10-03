// Refusals of the shared command handlers (task B03, ADR-M26). Like `RegistryError`, they carry a
// stable `code`; the API and the comment handler (B06) render codes through the message catalog.
export type CommandErrorCode =
  /** The gate cannot be decided through a command yet (B03: G1–G3 only; E01, E03 add G7, G8). */
  | 'gate_not_supported'
  /** The gate has no input to bind the decision to yet (no spec for G2, no plan for G3). */
  | 'gate_input_missing'
  /**
   * The intent is not waiting at this gate (task B07): a decision counts only for the gate the
   * workflow is at, so an early or late decision is refused instead of being ignored.
   */
  | 'gate_not_current'
  /**
   * An approval at G1–G3 carries a scope (task B07 session 2, D3): the gate advance has no
   * environment, resources or actions, so a scoped approval could never count.
   */
  | 'scope_not_allowed'
  /**
   * An approval at G3 of a plan that a run went outside of (task C07, QUESTIONS #131): G5 sent the
   * intent back to G3, and G3 needs a new plan (another plan hash).
   */
  | 'plan_refused'
  /**
   * An approval of G7 by a command (task E01, QUESTIONS #175): G7 approvals are GitHub reviews of
   * the pull request's head, so GitHub's merge rules and the platform see the same approvals.
   * `/reject G7` and `/request-changes G7` are accepted.
   */
  | 'g7_use_pr_review'
  /** Unknown intent, or an intent of a project the actor cannot read. */
  | 'intent_not_found'
  /** Unknown project, or a project the actor has no role on. */
  | 'project_not_found'
  /** The actor can read the project but the configuration does not let them do this. */
  | 'forbidden';

export class CommandError extends Error {
  override readonly name = 'CommandError';

  constructor(
    readonly code: CommandErrorCode,
    message: string,
  ) {
    super(message);
  }
}
