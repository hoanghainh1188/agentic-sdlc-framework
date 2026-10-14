// The handoff from the worker's evaluation loop to the runner (task L04, design/ADR-M81 §2.3,
// §2.8). The runner is a Temporal worker on a second task queue, `sdlc-runner-eval`, with its own
// activity slots, so an evaluation never queues behind a real run and never takes its slot.
//
// Inputs and results stay in the Temporal history: IDs, codes and single-use OpenBao wrapping
// tokens only. Never a raw token, a virtual key, a prompt, a task text, a diff or a path.

/** Temporal task queue of evaluation runs on the runner (QUESTIONS #461). */
export const EVALUATION_RUNNER_TASK_QUEUE = 'sdlc-runner-eval';

export interface ExecuteEvaluationRunInput {
  readonly tenantId: string;
  readonly evaluationRunId: string;
  /** The attempt the contract was issued for. */
  readonly attempt: number;
  /** Single-use wrapping token around `{ token }`: a single-repository read token (QUESTIONS #464). */
  readonly wrappedGitToken: string;
  /** Single-use wrapping token around `{ key }`: the run's LiteLLM virtual key, capped. */
  readonly wrappedVirtualKey: string;
}

export type ExecuteEvaluationRunResult =
  /** The run was scored: its result is stored, the run is `scored`. */
  | { readonly outcome: 'scored' }
  /** The run ended without a result (`failed`) or was stopped for a real run (`preempted`). */
  | { readonly outcome: 'failed'; readonly reason: string }
  | { readonly outcome: 'preempted' }
  /** The runner did not start the run: a refused contract, or a failed provisioning. */
  | { readonly outcome: 'refused'; readonly reason: string };

export interface EvaluationRunnerActivities {
  executeEvaluationRun(input: ExecuteEvaluationRunInput): Promise<ExecuteEvaluationRunResult>;
}
