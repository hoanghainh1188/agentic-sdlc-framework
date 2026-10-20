// The runner's Temporal activity for evaluation runs (task L04, design/ADR-M81 §2.3, §2.8). The
// runner is a second Temporal worker on the task queue `sdlc-runner-eval`, with its own activity
// slots (`SDLC_RUNNER_MAX_EVAL_SANDBOXES`), so an evaluation never queues behind a real run. The
// activity runs one evaluation run (`executeEvaluation`) and heartbeats while it lives; a lost
// heartbeat is a lost runner (the workflow ends and the run is queued again by the sweep). When the
// activity is cancelled (the evaluation stopped), the agent is stopped first and the run is
// `cancelled`. The input and the result hold IDs, codes, numbers and single-use wrapping tokens.
import type {
  CheckEvaluationTaskInput,
  CheckEvaluationTaskResult,
  EvaluationRunnerActivities,
  EvaluationTaskCheckActivities,
  ExecuteEvaluationRunInput,
  ExecuteEvaluationRunResult,
} from '@sdlc/contracts';
import type { PlatformLogger } from '@sdlc/core';
import { Context } from '@temporalio/activity';

import { checkTask } from './check.js';
import { executeEvaluation, type ExecuteEvaluationDeps } from './execute.js';

/** Heartbeat interval; the workflow's heartbeat timeout is 2 minutes. */
export const EVALUATION_HEARTBEAT_MS = 30_000;

export interface EvaluationActivityContextLike {
  heartbeat(): void;
  readonly cancellationSignal: AbortSignal;
}

export interface EvaluationActivityDeps {
  readonly execute: ExecuteEvaluationDeps;
  /** Default: `Context.current()`. */
  readonly context?: () => EvaluationActivityContextLike;
  readonly heartbeatMs?: number;
  /** Start and end of each run (codes only); the activity's log context adds tenant and run. */
  readonly logger?: PlatformLogger;
}

export function createEvaluationActivities(
  deps: EvaluationActivityDeps,
): EvaluationRunnerActivities & EvaluationTaskCheckActivities {
  return {
    /**
     * L07 (ADR-M85 §2.5): checks one project task on the same queue and slots. No agent: the
     * same deps without the adapter. Heartbeats like a run.
     */
    async checkEvaluationTask(input: CheckEvaluationTaskInput): Promise<CheckEvaluationTaskResult> {
      const ctx = (deps.context ?? (() => Context.current()))();
      ctx.heartbeat();
      const beat = setInterval(() => ctx.heartbeat(), deps.heartbeatMs ?? EVALUATION_HEARTBEAT_MS);
      deps.logger?.log('info', 'runner.task_check_started', { attempt: input.attempt });
      try {
        const result = await checkTask({ ...deps.execute, onStep: () => ctx.heartbeat() }, input, {
          signal: ctx.cancellationSignal,
        });
        deps.logger?.log(
          result.outcome === 'checked' ? 'info' : 'warn',
          'runner.task_check_ended',
          result.outcome === 'check_failed'
            ? { outcome: result.outcome, reason: result.code }
            : result.outcome === 'refused'
              ? { outcome: result.outcome, reason: result.reason }
              : { outcome: result.outcome },
        );
        return result;
      } finally {
        clearInterval(beat);
      }
    },
    async executeEvaluationRun(
      input: ExecuteEvaluationRunInput,
    ): Promise<ExecuteEvaluationRunResult> {
      const ctx = (deps.context ?? (() => Context.current()))();
      ctx.heartbeat();
      const beat = setInterval(() => ctx.heartbeat(), deps.heartbeatMs ?? EVALUATION_HEARTBEAT_MS);
      deps.logger?.log('info', 'runner.evaluation_started', { attempt: input.attempt });
      try {
        const result = await executeEvaluation(
          { ...deps.execute, onStep: () => ctx.heartbeat() },
          input,
          { signal: ctx.cancellationSignal },
        );
        deps.logger?.log(
          result.outcome === 'scored' ? 'info' : 'warn',
          'runner.evaluation_ended',
          result.outcome === 'failed' || result.outcome === 'refused'
            ? { outcome: result.outcome, reason: result.reason }
            : { outcome: result.outcome },
        );
        return result;
      } finally {
        clearInterval(beat);
      }
    },
  };
}
