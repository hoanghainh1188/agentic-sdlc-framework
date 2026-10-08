// G2 needs acceptance criteria (task S01, D-08 S01 AC3, D-02 §6.2 G2 "Acceptance criteria
// present", design/ADR-M61, QUESTIONS #290–#292).
//
// The rule is the same at every risk tier and oversight mode and is not configuration (#292):
// - a spec whose count is 0, or that was linked before S01 (no count, #290: fail closed), never
//   passes G2. The step records a system `fail spec_unclear` once per spec content, the notice
//   `spec_unclear`, and the intent waits at G2 (`spec_unclear`) until a person links a spec with
//   at least one criterion. The gate deadline still runs.
// - HOTL never passes it (`hotlConditionsHold`), and a person's `approve` is refused
//   (`decideGate`, `CommandError('spec_unclear')`). Rejections and requests for changes stay open.
// A `fail` is never a rejection (`gateHistory`), and E06 counts people's decisions only.
import type { SpecRef } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';

/** True when the spec has at least one acceptance criterion counted. */
export function specHasCriteria(spec: Pick<SpecRef, 'acceptance_criteria'>): boolean {
  return spec.acceptance_criteria !== null && spec.acceptance_criteria > 0;
}

/** The latest spec of the intent when it has no acceptance criteria; undefined otherwise. */
export async function specWithoutCriteria(
  scope: TenantScope,
  intentId: string,
): Promise<SpecRef | undefined> {
  const spec = await scope.specRefs.latest(intentId);
  return spec && !specHasCriteria(spec) ? spec : undefined;
}

/** True when the system `fail spec_unclear` for this spec content is recorded already. */
export async function specUnclearRecorded(
  scope: TenantScope,
  intentId: string,
  contentSha256: string,
): Promise<boolean> {
  return (await scope.gateDecisions.listForIntent(intentId, 'G2')).some(
    (d) =>
      d.decision === 'fail' && d.reason_code === 'spec_unclear' && d.input_sha256 === contentSha256,
  );
}
