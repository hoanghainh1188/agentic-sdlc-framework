// G3 after G5 sent the intent back (task C07, QUESTIONS #131, design/ADR-M34 §2.8):
// - G3 is HITL at every tier from then on (`GateContext.returnedFromG5`, like a forced-HITL flag),
//   after a run went outside its plan, and after a person decided `modify` or `roll_back` on a G5
//   escalation (Harry, C07 PR 2 decision A);
// - the plan a run went outside of can never be approved again: G3 needs a new plan hash. A
//   `modify` or `roll_back` allows the same plan: a person decides at G3.
// Both read stored facts: the audit events `gate.g5_check_failed` with the check `out_of_scope`,
// and the closed G5 escalations with their decision.
import type { TenantScope } from '../db/tenant-scope.js';

/** Decisions on a G5 escalation that send the intent back to G3. */
export const G5_RETURN_DECISIONS: readonly string[] = ['modify', 'roll_back'];

async function scopeFailures(scope: TenantScope, intentId: string): Promise<string[]> {
  const events = await scope.audit.listForEntity(intentId, ['gate.g5_check_failed']);
  return events
    .map((e) => e.payload as { check?: unknown; run_id?: unknown })
    .filter((p) => p.check === 'out_of_scope' && typeof p.run_id === 'string')
    .map((p) => p.run_id as string);
}

/**
 * True when G5 ever sent the intent back to G3: a run went outside its plan, or a person decided
 * `modify` or `roll_back` on a G5 escalation.
 */
export async function returnedFromG5(scope: TenantScope, intentId: string): Promise<boolean> {
  if ((await scopeFailures(scope, intentId)).length > 0) return true;
  return (await scope.escalations.listForIntent(intentId)).some(
    (e) =>
      e.status === 'closed' &&
      e.packet.gate === 'G5' &&
      G5_RETURN_DECISIONS.includes(String(e.decision?.decision)),
  );
}

/** The hashes of the plans that a run of the intent went outside of. */
export async function refusedPlanHashes(
  scope: TenantScope,
  intentId: string,
): Promise<ReadonlySet<string>> {
  const runIds = await scopeFailures(scope, intentId);
  if (runIds.length === 0) return new Set();
  const plans = await scope.plans.list(intentId);
  const hashes = new Set<string>();
  for (const runId of runIds) {
    const run = await scope.runs.getById(runId);
    const plan = plans.find((p) => p.id === run?.plan_id);
    if (plan) hashes.add(plan.plan_sha256);
  }
  return hashes;
}
