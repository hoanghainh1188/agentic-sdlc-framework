// Refusals of the kill switch (task C11, ADR-M42). Codes only; the API, the CLI and the comment
// handler render them through the message catalog (`kill.error.*`).
export const KILL_ERROR_CODES = [
  /** Unknown run, or a run of a project the actor has no role on. */
  'run_not_found',
  /** The actor has a role on the project, but not one of config `access.kill_roles`. */
  'forbidden',
  /** The run already ended (other than by a kill): there is nothing to stop. */
  'run_not_active',
  /** The intent has no run to stop (comment `/kill`, CLI with an intent code). */
  'no_active_run',
] as const;
export type KillErrorCode = (typeof KILL_ERROR_CODES)[number];

export class KillError extends Error {
  override readonly name = 'KillError';

  constructor(
    readonly code: KillErrorCode,
    message: string,
  ) {
    super(message);
  }
}
