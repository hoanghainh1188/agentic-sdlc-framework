// The end of an evaluation run, on the worker's side (task L04, design/ADR-M81 §2.8). The runner
// scores a run and leaves it `running`; the worker revokes the run's key, reads the cost of its
// calls from the cost records (after a spend sync) and writes the result. Then it checks the
// budget and ends the evaluation when no run is left to do. Safe to call again: a run that is no
// longer `running` is left as it is.
//
// - `scored`: the result is the runner's measures plus the model calls, tokens and cost from the
//   cost records. The gateway writes its spend logs in batches, so a scored run with no calls yet
//   is synced again a few times (`costWait`) before the result is written with what is there.
// - `failed`: the run ends `failed` with the runner's reason code.
// - `preempted`, `cancelled`: the runner changed the run already; nothing to write.
// - `refused`: the runner did not start the run; it gets its next attempt (a new contract).
// - `lost`: the runner is gone (heartbeat lost). The run is queued again, or fails after
//   `MAX_EVALUATION_ATTEMPTS` (the same rule as the runner's restart clean-up).
import type { EvaluationScoredMeasures } from '@sdlc/contracts';

import type { CostController } from '../cost/controller.js';
import type { NewEvaluationRunResult } from '../db/repositories/evaluation-runs.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { stopEvaluationIfBudgetUsed } from './budget.js';

/** An evaluation run that keeps losing its runner fails after this many attempts (ADR-M81 §2.3). */
export const MAX_EVALUATION_ATTEMPTS = 3;

/** The stop reason of a run that was cancelled before a runner took it (a code). */
export const EVALUATION_STOPPED = 'evaluation_stopped';

export type EvaluationRunEnd =
  | { readonly outcome: 'scored'; readonly measures: EvaluationScoredMeasures }
  | { readonly outcome: 'failed'; readonly reason: string }
  | { readonly outcome: 'preempted' }
  | { readonly outcome: 'cancelled' }
  | { readonly outcome: 'refused'; readonly reason: string }
  | { readonly outcome: 'lost' };

export interface FinishEvaluationDeps {
  readonly costController: Pick<CostController, 'endRunKey' | 'syncSpend'>;
  /** Default: `new Date()`. */
  readonly now?: () => Date;
  /** Waits between spend syncs for a scored run without calls; default: a timer. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** How often and how long to look for the calls of a scored run. */
  readonly costWait?: { readonly attempts: number; readonly intervalMs: number };
}

export interface FinishEvaluationInput {
  readonly evaluationRunId: string;
  readonly attempt: number;
  /** When the run's key was issued: the spend sync starts here. */
  readonly keyIssuedAt: Date;
  readonly end: EvaluationRunEnd;
}

const DEFAULT_COST_WAIT = { attempts: 3, intervalMs: 5_000 } as const;

/** Writes the end of one run, checks the budget, ends the evaluation if it is done. */
export async function finishEvaluationRun(
  scope: TenantScope,
  deps: FinishEvaluationDeps,
  input: FinishEvaluationInput,
): Promise<void> {
  const run = await scope.evaluationRuns.getById(input.evaluationRunId);
  if (!run) return;
  const { end } = input;
  // The key is revoked and the spend synced whatever happened: a run that ended any way must not
  // leave a live key behind.
  // The loop does not prepare the next attempt while this attempt's workflow lives, so the key
  // revoked here is always this attempt's.
  await deps.costController.endRunKey({ runId: run.id, syncFrom: input.keyIssuedAt });
  if (run.attempt === input.attempt && run.status === 'running') {
    switch (end.outcome) {
      case 'scored':
        await writeResult(scope, deps, input, end.measures);
        break;
      case 'failed':
        await scope.evaluationRuns.markFailed(run.id, end.reason);
        break;
      case 'lost':
        await abandon(scope, run.id, run.attempt);
        break;
      default:
        // preempted, cancelled: the runner moved the run. refused: only a queued run is refused.
        break;
    }
  } else if (end.outcome === 'refused' && run.status === 'queued') {
    await scope.evaluationRuns.nextAttempt(run.id, input.attempt);
  } else if (end.outcome === 'cancelled' && run.attempt === input.attempt) {
    // Cancelled before a runner took the run: nobody else will end it.
    await scope.evaluationRuns.cancelOne(run.id, EVALUATION_STOPPED);
  }
  await closeIfDone(scope, run.evaluation_id);
}

async function abandon(scope: TenantScope, runId: string, attempt: number): Promise<void> {
  if (attempt >= MAX_EVALUATION_ATTEMPTS) {
    await scope.evaluationRuns.markFailed(runId, 'runner_lost');
    return;
  }
  if (await scope.evaluationRuns.markPreempted(runId)) await scope.evaluationRuns.requeue(runId);
}

async function writeResult(
  scope: TenantScope,
  deps: FinishEvaluationDeps,
  input: FinishEvaluationInput,
  m: EvaluationScoredMeasures,
): Promise<void> {
  const wait = deps.costWait ?? DEFAULT_COST_WAIT;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let totals = await scope.costRecords.totalsForEvaluationRun(input.evaluationRunId);
  for (let tries = 0; tries < wait.attempts && totals.modelCalls === 0 && m.iterations > 0;) {
    tries += 1;
    await sleep(wait.intervalMs);
    await deps.costController.syncSpend({
      from: input.keyIssuedAt,
      to: deps.now ? deps.now() : new Date(),
    });
    totals = await scope.costRecords.totalsForEvaluationRun(input.evaluationRunId);
  }
  const result: NewEvaluationRunResult = {
    instructions_sha256: m.instructionsSha256,
    outcome: m.agentOutcome,
    status: m.status,
    stop_reason: m.stopReason,
    applied: m.applied,
    resolved: m.applied && m.failToPass && m.passToPass,
    fail_to_pass_passed: m.failToPass,
    pass_to_pass_passed: m.passToPass,
    ci_passed: m.ci,
    scope_breach: m.outOfPlanFiles > 0,
    out_of_plan_files: m.outOfPlanFiles,
    lint_findings: m.lintFindings,
    diff_files: m.diffFiles,
    diff_lines_added: m.diffLinesAdded,
    diff_lines_removed: m.diffLinesRemoved,
    seconds: m.seconds,
    iterations: m.iterations,
    model_calls: totals.modelCalls,
    input_tokens: totals.inputTokens,
    output_tokens: totals.outputTokens,
    cached_input_tokens: Math.min(totals.cachedInputTokens, totals.inputTokens),
    cost_usd: totals.costUsd,
    hardware: m.hardware,
  };
  await scope.evaluationRuns.recordResult(input.evaluationRunId, result);
}

/** Stops the evaluation when its budget is used up, ends it when none of its runs is left to do. */
async function closeIfDone(scope: TenantScope, evaluationId: string): Promise<void> {
  if (await stopEvaluationIfBudgetUsed(scope, evaluationId)) return;
  const evaluation = await scope.evaluations.getById(evaluationId);
  if (evaluation?.status !== 'queued' && evaluation?.status !== 'running') return;
  const counts = await scope.evaluations.counts(evaluationId);
  if (counts.queued + counts.running + counts.preempted > 0) return;
  if (counts.scored > 0) await scope.evaluations.finish(evaluationId, 'completed', null);
  else await scope.evaluations.finish(evaluationId, 'failed', 'no_run_scored');
}
