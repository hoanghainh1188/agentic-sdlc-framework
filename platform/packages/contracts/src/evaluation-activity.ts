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

/** The machine that ran the evaluation (ADR-M81 §2.1): names and numbers, never a path or a host. */
export interface EvaluationHardwareBlock {
  readonly cpu_model: string;
  readonly cpu_cores: number;
  readonly memory_gb: number;
  readonly docker_version: string;
  readonly gpu: string | null;
  readonly runner_instance: string | null;
}

/**
 * What the runner measured for a scored run: codes and numbers only. The worker adds the model
 * calls, the tokens and the cost from the cost records and writes the result (ADR-M81 §2.8).
 */
export interface EvaluationScoredMeasures {
  /** How the agent run ended: `finished`, `max_iterations`, `max_duration`, … (a code). */
  readonly agentOutcome: string;
  /** The status the run would have had (`succeeded`, `stopped_budget`, …), as in ADR-M78. */
  readonly status: string;
  readonly stopReason: string | null;
  readonly seconds: number;
  readonly iterations: number;
  /** Files the agent changed outside the task's plan (counted, never named). */
  readonly outOfPlanFiles: number;
  readonly diffFiles: number;
  readonly diffLinesAdded: number;
  readonly diffLinesRemoved: number;
  readonly applied: boolean;
  readonly ci: boolean;
  readonly passToPass: boolean;
  readonly failToPass: boolean;
  readonly lintFindings: number;
  /** SHA-256 of the instructions the agent read (`AGENTS.md`). */
  readonly instructionsSha256: string;
  readonly hardware: EvaluationHardwareBlock;
}

export type ExecuteEvaluationRunResult =
  /** The run was scored. The run stays `running` until the worker writes the result. */
  | { readonly outcome: 'scored'; readonly measures: EvaluationScoredMeasures }
  /** The run ended without a result and is `failed` (a code: `scoring_install_failed`, …). */
  | { readonly outcome: 'failed'; readonly reason: string }
  /** A real run needed the slot: the agent was stopped, the run is queued again (next attempt). */
  | { readonly outcome: 'preempted' }
  /** The workflow cancelled the activity (the evaluation stopped): the run is `cancelled`. */
  | { readonly outcome: 'cancelled' }
  /**
   * The runner did not start the run: a refused contract (`expired`, …) or a run that is not
   * startable. After a refusal for the contract the run gets its next attempt.
   */
  | { readonly outcome: 'refused'; readonly reason: string };

export interface EvaluationRunnerActivities {
  executeEvaluationRun(input: ExecuteEvaluationRunInput): Promise<ExecuteEvaluationRunResult>;
}
