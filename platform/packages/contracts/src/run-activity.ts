// The handoff from the intent workflow to the runner (task C06 session 2, design/ADR-M33 §2.6,
// QUESTIONS #53, #55, #112). The runner process is a Temporal worker on its own task queue; one
// long-running activity per run, with heartbeats. Its slots are the runner's sandbox limit, so
// extra runs wait in Temporal (D-03 §10.1).
//
// Activity inputs and results stay in the Temporal history, so they hold IDs, codes and the two
// single-use OpenBao wrapping tokens only (their time to live is the contract's validity). Never a
// raw token, a virtual key, a key ID or client data.

/** Temporal task queue of the runner (ADR-M25 §2.7). */
export const RUNNER_TASK_QUEUE = 'sdlc-runner';

export interface ExecuteRunInput {
  readonly tenantId: string;
  readonly runId: string;
  /** The agent's pinned gateway model (QUESTIONS #79). */
  readonly modelRef: string;
  /** Single-use wrapping token around `{ token }`: the run's GitHub token (QUESTIONS #44). */
  readonly wrappedGitToken: string;
  /** Single-use wrapping token around `{ key }`: the run's LiteLLM virtual key (QUESTIONS #112). */
  readonly wrappedVirtualKey: string;
}

export type ExecuteRunResult =
  /** The runner provisioned the sandbox and drove the agent; the run has a final status. */
  | { readonly outcome: 'ended'; readonly status: string; readonly stopReason: string | null }
  /**
   * The runner did not start the run: the contract was refused (for example `expired`), or
   * provisioning failed. `reason` is a code (ADR-M22 §2.4, ADR-M25 §2.8).
   */
  | { readonly outcome: 'refused'; readonly reason: string };

/** Activities of the runner's Temporal worker. */
export interface RunnerActivities {
  executeRun(input: ExecuteRunInput): Promise<ExecuteRunResult>;
}
