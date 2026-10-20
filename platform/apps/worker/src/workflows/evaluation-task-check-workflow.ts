// The workflow of one check of a project's evaluation task (task L07, design/ADR-M85 §2.5). One
// workflow per task, card and attempt (ID `evaluation-task-check/<tenant>/<task>/<card>/<attempt>`):
// it hands the check to the runner on `sdlc-runner-eval` (free slots only, one attempt), then asks
// the worker to write the answer (`finishEvaluationTaskCheck`), out of any cancellation. A runner
// that does not answer is `lost`: the check is handed over again by the loop. The workflow holds
// IDs, a hash, one number and one single-use wrapping token: never a secret or client data.
//
// Deterministic code only: bundled for the Temporal workflow sandbox (lint rule in eslint config).
import {
  EVALUATION_RUNNER_TASK_QUEUE,
  type CheckEvaluationTaskInput,
  type CheckEvaluationTaskResult,
  type EvaluationTaskCheckActivities,
  type EvaluationTaskCheckWorkflowResult,
} from '@sdlc/contracts';
import { CancellationScope, proxyActivities } from '@temporalio/workflow';

import type { IntentActivities } from '../activities/intent-activities.js';

const { checkEvaluationTask } = proxyActivities<EvaluationTaskCheckActivities>({
  taskQueue: EVALUATION_RUNNER_TASK_QUEUE,
  // A check waits for a free slot, then installs and scores twice.
  scheduleToCloseTimeout: '8 hours',
  startToCloseTimeout: '2 hours',
  heartbeatTimeout: '2 minutes',
  retry: { maximumAttempts: 1 },
});

// The answer must be written even when the worker restarts: retried, and idempotent in core.
const { finishEvaluationTaskCheck } = proxyActivities<IntentActivities>({
  startToCloseTimeout: '2 minutes',
  retry: { maximumAttempts: 8, initialInterval: '5 seconds', maximumInterval: '2 minutes' },
});

export async function evaluationTaskCheckWorkflow(
  input: CheckEvaluationTaskInput,
): Promise<EvaluationTaskCheckWorkflowResult> {
  let answer: CheckEvaluationTaskResult | { readonly outcome: 'lost' };
  try {
    answer = await checkEvaluationTask(input);
  } catch {
    answer = { outcome: 'lost' };
  }
  await CancellationScope.nonCancellable(() =>
    finishEvaluationTaskCheck({
      tenantId: input.tenantId,
      evaluationTaskId: input.evaluationTaskId,
      cardSha256: input.cardSha256,
      attempt: input.attempt,
      end: answer,
    }),
  );
  return answer.outcome;
}
