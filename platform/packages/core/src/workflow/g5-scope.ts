// G3 after G5 sent the intent back for scope (task C07, QUESTIONS #131, design/ADR-M34 §2.8):
// - G3 is HITL at every tier from then on (`GateContext.scopeReturned`, like a forced-HITL flag);
// - the plan a run went outside of can never be approved again: G3 needs a new plan hash.
// Both read the audit events `gate.g5_check_failed` with the check `out_of_scope`.
import type { TenantScope } from '../db/tenant-scope.js';

async function scopeFailures(scope: TenantScope, intentId: string): Promise<string[]> {
  const events = await scope.audit.listForEntity(intentId, ['gate.g5_check_failed']);
  return events
    .map((e) => e.payload as { check?: unknown; run_id?: unknown })
    .filter((p) => p.check === 'out_of_scope' && typeof p.run_id === 'string')
    .map((p) => p.run_id as string);
}

/** True when G5 ever sent the intent back to G3 because a run went outside its plan. */
export async function scopeReturned(scope: TenantScope, intentId: string): Promise<boolean> {
  return (await scopeFailures(scope, intentId)).length > 0;
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
