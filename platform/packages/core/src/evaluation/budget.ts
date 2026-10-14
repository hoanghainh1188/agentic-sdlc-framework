// The budget of an evaluation (task L04, design/ADR-M81 §2.4; QUESTIONS #462). Each evaluation has
// its own budget; each run's virtual key is capped at what is left; the evaluation stops when the
// budget is used up. The cost is read from the cost records of its runs, never from a second
// counter. A budget goes up only by a decision (ADR-M28), never here.
import { fromMicros, toMicros } from '../cost/money.js';
import type { Evaluation } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';

/** The stop reason of an evaluation whose budget is used up. */
export const EVALUATION_BUDGET_USED = 'budget_used';

export interface EvaluationBudget {
  readonly budgetUsd: string;
  readonly spentUsd: string;
  /** Never negative: spend can pass the budget by the calls that were in flight. */
  readonly remainingUsd: string;
  readonly used: boolean;
}

/** The budget, the spend and what is left, as decimal strings. */
export async function evaluationBudget(
  scope: TenantScope,
  evaluation: Pick<Evaluation, 'id' | 'budget_usd'>,
): Promise<EvaluationBudget> {
  const spent = toMicros(await scope.evaluations.spentUsd(evaluation.id));
  const budget = toMicros(evaluation.budget_usd);
  const left = budget - spent;
  return {
    budgetUsd: fromMicros(budget),
    spentUsd: fromMicros(spent),
    remainingUsd: fromMicros(left > 0n ? left : 0n),
    used: left <= 0n,
  };
}

/**
 * The cap of the virtual key of the next run: what is left of the budget. Null when nothing is
 * left, so no key is issued (ADR-M81 §2.4).
 */
export async function nextRunKeyCap(
  scope: TenantScope,
  evaluation: Pick<Evaluation, 'id' | 'budget_usd'>,
): Promise<string | null> {
  const budget = await evaluationBudget(scope, evaluation);
  return budget.used ? null : budget.remainingUsd;
}

/**
 * Stops the evaluation when its budget is used up: the runs nobody works on are cancelled, the
 * evaluation ends `stopped_budget` and `evaluation.finished` is written. Running runs end through
 * their runner (the loop of PR 4 stops them). Returns true when this call stopped it.
 */
export async function stopEvaluationIfBudgetUsed(
  scope: TenantScope,
  evaluationId: string,
): Promise<boolean> {
  return scope.transaction(async (tx) => {
    const evaluation = await tx.evaluations.getById(evaluationId);
    if (!evaluation || (evaluation.status !== 'queued' && evaluation.status !== 'running')) {
      return false;
    }
    if (!(await evaluationBudget(tx, evaluation)).used) return false;
    await tx.evaluationRuns.cancelWaiting(evaluationId, EVALUATION_BUDGET_USED);
    const finished = await tx.evaluations.finish(
      evaluationId,
      'stopped_budget',
      EVALUATION_BUDGET_USED,
    );
    return finished !== undefined;
  });
}
