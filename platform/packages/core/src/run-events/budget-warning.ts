// The budget warning of a run (task C07, D-02 FR-52, D-08 C07 AC2, design/ADR-M34 §2.6): the
// runner records the run event `budget_warning` and the intent's status notice `budget_warning` in
// one transaction, so the warning comment appears on the issue while the agent still works (Harry,
// C07 PR 2 decision C). The notice holds codes only; the comment reads the percent from the run
// event when it is posted. Person A operates the runs and is mentioned.
import type { ProjectRole } from '@sdlc/contracts';

import { DbError } from '../db/errors.js';
import type { TenantScope } from '../db/tenant-scope.js';

/** Who hears about the budget warning: Person A operates the runs (handbook Ch.13 §13.3). */
const WARNING_AUDIENCE: readonly ProjectRole[] = ['person_a'];

export interface BudgetWarning {
  readonly spend_usd: string;
  readonly max_budget_usd: string;
  readonly percent: number;
}

/** Appends `budget_warning` to the run and records the intent's notice, in one transaction. */
export async function recordBudgetWarning(
  scope: TenantScope,
  input: { readonly runId: string; readonly intentId: string },
  warning: BudgetWarning,
): Promise<void> {
  await scope.transaction(async (tx) => {
    const intent = await tx.intents.getById(input.intentId);
    if (!intent) throw new DbError('reference_not_found', `intent ${input.intentId} not found`);
    await tx.runEvents.append(input.runId, 'budget_warning', { ...warning });
    await tx.intentNotices.record({
      intentId: intent.id,
      kind: 'budget_warning',
      status: intent.status,
      gate: intent.current_gate,
      previousGate: null,
      decisionId: null,
      audienceRoles: WARNING_AUDIENCE,
    });
  });
}
