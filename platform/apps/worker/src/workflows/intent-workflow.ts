// The intent workflow on Temporal (D-08 B07 AC1 and AC5, design/D-03 section 6, ADR-M30).
//
// A thin durable loop. The database is the source of truth: the `stepIntent` activity reads the
// intent under its lock and makes at most one move (core `stepIntent`). The workflow steps again
// after a move, waits for a wake signal when there is nothing to do, and ends when the intent is
// finished. It holds no client data: its input, signal and activity results are IDs and codes.
//
// Deterministic code only: this file is bundled for the Temporal workflow sandbox and may import
// `@temporalio/workflow`, `@sdlc/contracts` and types (lint rule in eslint.config.mjs).
// The escalation clocks are not timers here (ADR-M28): the workflow asks the database.
import { INTENT_WAKE_SIGNAL, type IntentStepResult, type IntentWorkflowRef } from '@sdlc/contracts';
import {
  condition,
  continueAsNew,
  defineSignal,
  proxyActivities,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';

import type { IntentActivities } from '../activities/intent-activities.js';

export const wakeSignal = defineSignal(INTENT_WAKE_SIGNAL);

/**
 * Moves in a row before the workflow waits for a signal anyway. G1–G3 need at most 4 moves on one
 * wake-up; the cap stops a loop if a move keeps being reported without progress.
 */
export const MAX_MOVES_PER_WAKE = 16;

const { stepIntent } = proxyActivities<IntentActivities>({
  startToCloseTimeout: '1 minute',
  retry: {
    initialInterval: '1 second',
    maximumInterval: '1 minute',
    // A missing intent never appears later: fail the workflow instead of retrying for ever.
    nonRetryableErrorTypes: ['WorkflowError'],
  },
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
    if (result.outcome === 'moved' && moves < MAX_MOVES_PER_WAKE) {
      moves += 1;
      continue;
    }
    moves = 0;
    await condition(() => wakes !== seen);
    // Long waits with many wake-ups: start a fresh history (the state lives in the database).
    if (workflowInfo().continueAsNewSuggested) {
      await continueAsNew<typeof intentWorkflow>(ref);
    }
  }
}
