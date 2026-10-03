// The intent workflow on Temporal (D-08 B07 AC1 and AC5, design/D-03 section 6, ADR-M30; the run
// after G4: D-08 C06 AC4, ADR-M33 §2.6).
//
// A thin durable loop. The database is the source of truth: the `stepIntent` activity reads the
// intent under its lock and makes at most one move (core `stepIntent`). The workflow steps again
// after a move, waits for a wake signal when there is nothing to do, and ends when the intent is
// finished. It holds no client data: its input, signal and activity results are IDs and codes.
//
// C06 session 2: when G4 is decided the step asks for a run (`run_prepare`). The workflow prepares
// it (`prepareRun`, worker), hands it to the runner (`executeRun` on the task queue `sdlc-runner`:
// one long-running activity with heartbeats, one attempt), and asks the step again. When the run
// ended the step says `run_ended` and the workflow calls `finishRun`. A lost runner (heartbeat
// timeout, activity failure) → `abandonRun`: the run's key is revoked at once and the run fails.
// Old histories never saw the run outcomes, so the new branches replay them unchanged (no patch).
//
// C08 (ADR-M38 §2.1): when G5 passed a run and its block window closed, the step says `publish`.
// `push`: `preparePublish` (worker: a single-repository `contents: write` token, wrapped), then
// `publishRun` on the runner's queue (one attempt, heartbeats), then `finishPublish` (worker: the
// pull request). `open_pr`: `finishPublish` only. A lost runner counts as a failed attempt
// (`abandonPublish`); a failed push waits `RUN_ACTIVITY_RETRY_MS` before the step is asked again.
//
// Deterministic code only: this file is bundled for the Temporal workflow sandbox and may import
// `@temporalio/workflow`, `@sdlc/contracts` and types (lint rule in eslint.config.mjs).
// The escalation clocks are not timers here (ADR-M28): the workflow asks the database. The only
// timers are the one a step asks for (`wakeInMs`) and the pause after a failed activity.
import {
  INTENT_WAKE_SIGNAL,
  RUNNER_TASK_QUEUE,
  type IntentStepResult,
  type IntentWorkflowRef,
  type RunnerActivities,
} from '@sdlc/contracts';
import {
  condition,
  continueAsNew,
  defineSignal,
  proxyActivities,
  setHandler,
  sleep,
  workflowInfo,
} from '@temporalio/workflow';

import type { IntentActivities } from '../activities/intent-activities.js';

export const wakeSignal = defineSignal(INTENT_WAKE_SIGNAL);

/**
 * Moves in a row before the workflow waits for a signal anyway. G1–G3 need at most 4 moves on one
 * wake-up; the cap stops a loop if a move keeps being reported without progress.
 */
export const MAX_MOVES_PER_WAKE = 16;

/** Shortest timer the workflow sets for a `wakeInMs`. */
export const MIN_TIMER_MS = 1000;

/** Pause before the workflow asks again after a run activity failed (the worker, not the run). */
export const RUN_ACTIVITY_RETRY_MS = 60_000;

const { stepIntent } = proxyActivities<IntentActivities>({
  startToCloseTimeout: '1 minute',
  retry: {
    initialInterval: '1 second',
    maximumInterval: '1 minute',
    // A missing intent never appears later: fail the workflow instead of retrying for ever.
    nonRetryableErrorTypes: ['WorkflowError'],
  },
});

// The run activities are not retried by Temporal: a retry could issue a second contract or finish
// twice. The database says what to do next, so the workflow simply asks the step again.
const { prepareRun, finishRun, abandonRun, preparePublish, finishPublish, abandonPublish } =
  proxyActivities<IntentActivities>({
    startToCloseTimeout: '5 minutes',
    retry: { maximumAttempts: 1 },
  });

// One run = one attempt. The runner sends a heartbeat at least every 30 seconds; a lost heartbeat
// means the runner is gone (ADR-M33 §2.7). The run itself is capped by its contract
// (`max_duration_min`, at most a few hours in the MVP).
const { executeRun } = proxyActivities<RunnerActivities>({
  taskQueue: RUNNER_TASK_QUEUE,
  startToCloseTimeout: '12 hours',
  heartbeatTimeout: '2 minutes',
  retry: { maximumAttempts: 1 },
});

// C08: one push = one attempt (clone, apply, push; minutes, not hours).
const { publishRun } = proxyActivities<RunnerActivities>({
  taskQueue: RUNNER_TASK_QUEUE,
  startToCloseTimeout: '15 minutes',
  heartbeatTimeout: '2 minutes',
  retry: { maximumAttempts: 1 },
});

export async function intentWorkflow(ref: IntentWorkflowRef): Promise<string> {
  let wakes = 0;
  setHandler(wakeSignal, () => {
    wakes += 1;
  });
  let moves = 0;
  for (;;) {
    const seen = wakes;
    const result: IntentStepResult = await stepIntent(ref);
    if (result.outcome === 'finished') return result.status;
    if (moves < MAX_MOVES_PER_WAKE) {
      if (result.outcome === 'moved') {
        moves += 1;
        continue;
      }
      if (result.outcome === 'run_prepare' || result.outcome === 'run_ended') {
        moves += 1;
        if (!(await driveRun(ref, result))) await sleep(RUN_ACTIVITY_RETRY_MS);
        continue;
      }
      if (result.outcome === 'publish') {
        moves += 1;
        if (!(await drivePublish(ref, result))) await sleep(RUN_ACTIVITY_RETRY_MS);
        continue;
      }
    }
    moves = 0;
    const wakeInMs = result.outcome === 'waiting' ? result.wakeInMs : undefined;
    if (wakeInMs === undefined) {
      await condition(() => wakes !== seen);
    } else {
      // At least one second: a deadline that just passed is handled by the next step anyway.
      await condition(() => wakes !== seen, Math.max(MIN_TIMER_MS, wakeInMs));
    }
    // Long waits with many wake-ups: start a fresh history (the state lives in the database).
    if (workflowInfo().continueAsNewSuggested) {
      await continueAsNew<typeof intentWorkflow>(ref);
    }
  }
}

/**
 * One piece of a run's round. Returns false when a worker activity failed (the workflow waits a
 * little and asks the step again); the runner's failure is not one: the run is abandoned.
 */
async function driveRun(
  ref: IntentWorkflowRef,
  result: Extract<IntentStepResult, { outcome: 'run_prepare' | 'run_ended' }>,
): Promise<boolean> {
  try {
    if (result.outcome === 'run_ended') {
      await finishRun(ref, result.runId);
      return true;
    }
    const prepared = await prepareRun(ref);
    if (!prepared.ok) return true;
    try {
      await executeRun({
        tenantId: ref.tenantId,
        runId: prepared.runId,
        modelRef: prepared.modelRef,
        wrappedGitToken: prepared.wrappedGitToken,
        wrappedVirtualKey: prepared.wrappedVirtualKey,
      });
    } catch {
      // Heartbeat timeout, the runner stopped, or the activity failed: the run is lost.
      await abandonRun(ref, prepared.runId);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * The push and the pull request at G6 (C08). Returns false when an activity failed or the push
 * failed for a cause that may pass: the workflow waits a little and asks the step again, which
 * stops after `MAX_PUBLISH_ATTEMPTS` (core).
 */
async function drivePublish(
  ref: IntentWorkflowRef,
  result: Extract<IntentStepResult, { outcome: 'publish' }>,
): Promise<boolean> {
  try {
    if (result.step === 'push') {
      const prepared = await preparePublish(ref, result.runId);
      if (!prepared.ok) return prepared.reason !== 'token_failed';
      let pushed;
      try {
        pushed = await publishRun({
          tenantId: ref.tenantId,
          runId: result.runId,
          wrappedPushToken: prepared.wrappedPushToken,
        });
      } catch {
        await abandonPublish(ref, result.runId, 'runner_lost');
        return false;
      }
      if (pushed.outcome === 'failed') return false;
      if (pushed.outcome === 'refused') return true;
    }
    const finished = await finishPublish(ref, result.runId);
    return finished.ok || finished.reason !== 'pr_failed';
  } catch {
    // A worker activity failed unexpectedly: count it, so the round never retries for ever.
    try {
      await abandonPublish(ref, result.runId, 'worker_failed');
    } catch {
      // The database is down too: the pause below and the next step try again.
    }
    return false;
  }
}
