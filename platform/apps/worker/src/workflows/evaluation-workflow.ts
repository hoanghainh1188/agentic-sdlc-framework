// The workflow of one evaluation run (task L04, design/ADR-M81 §2.3, §2.8). One workflow per run
// and attempt (ID `evaluation-run/<tenant>/<run>/<attempt>`): it hands the run to the runner on
// the task queue `sdlc-runner-eval` (one long activity with heartbeats, one attempt), then asks
// the worker to finish the run (`finishEvaluationRun`: revoke the key, write the result with the
// cost, check the budget, end the evaluation). The database is the source of truth; the workflow
// holds IDs, codes, one time and two single-use wrapping tokens, never a secret or client data.
//
// - The runner answers `scored`, `failed`, `preempted`, `cancelled` or `refused`: the worker
//   finishes the run with that answer.
// - A lost runner (heartbeat timeout, activity failure) is `lost`: the run is queued again, or
//   fails after the attempt limit.
// - The workflow is cancelled when the evaluation ends (budget, stop): the runner stops the agent
//   (`WAIT_CANCELLATION_COMPLETED`), then the worker finishes the run, out of the cancelled scope.
//
// Deterministic code only: bundled for the Temporal workflow sandbox (lint rule in eslint config).
import {
  EVALUATION_RUNNER_TASK_QUEUE,
  type EvaluationRunnerActivities,
  type EvaluationRunWorkflowInput,
  type EvaluationRunWorkflowResult,
  type ExecuteEvaluationRunResult,
} from '@sdlc/contracts';
import {
  ActivityCancellationType,
  CancellationScope,
  isCancellation,
  proxyActivities,
} from '@temporalio/workflow';

import type { IntentActivities } from '../activities/intent-activities.js';

const { executeEvaluationRun } = proxyActivities<EvaluationRunnerActivities>({
  taskQueue: EVALUATION_RUNNER_TASK_QUEUE,
  // A run waits for a free slot, then runs up to its contract's duration plus scoring.
  scheduleToCloseTimeout: '14 hours',
  startToCloseTimeout: '12 hours',
  heartbeatTimeout: '2 minutes',
  retry: { maximumAttempts: 1 },
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
});

// The result must be written even when the worker restarts: retried, and idempotent in core.
const { finishEvaluationRun } = proxyActivities<IntentActivities>({
  startToCloseTimeout: '5 minutes',
  retry: { maximumAttempts: 8, initialInterval: '5 seconds', maximumInterval: '2 minutes' },
});

export async function evaluationRunWorkflow(
  input: EvaluationRunWorkflowInput,
): Promise<EvaluationRunWorkflowResult> {
  const { keyIssuedAt, ...runnerInput } = input;
  let answer: ExecuteEvaluationRunResult | { readonly outcome: 'lost' };
  try {
    answer = await executeEvaluationRun(runnerInput);
  } catch (error) {
    // Cancelled (the evaluation ended) or the runner was lost: either way the run is finished.
    answer = isCancellation(error) ? { outcome: 'cancelled' } : { outcome: 'lost' };
  }
  await CancellationScope.nonCancellable(() =>
    finishEvaluationRun({
      tenantId: input.tenantId,
      evaluationRunId: input.evaluationRunId,
      attempt: input.attempt,
      keyIssuedAt,
      end: answer,
    }),
  );
  return answer.outcome;
}
