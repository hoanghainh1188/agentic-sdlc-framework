// The oversight of a gate as the intent workflow resolves it while the intent waits there (task
// U01, QUESTIONS #261, design/ADR-M54 §2.4). One function for the workflow's steps and for the
// API's `waiting_for`, so the dashboard never shows another resolution than the one the workflow
// acts on:
// - G1–G4, G7: the change flags of the intent's latest plan (the plan G3 passed: a new plan sends
//   the intent back to G3, B09); G3 is HITL once G5, G6 or G7 sent the intent back
//   (`returnedFromG5`, C07);
// - G5: no change flags, not breached (a breach pauses the intent: it no longer waits at G5);
// - G6: no change flags, the findings of the last CI reading (unknown → HITL, QUESTIONS #157);
// - G8: the latest plan's change flags, always production (QUESTIONS #220).
import type {
  ChangeFlag,
  GateCode,
  OversightResolution,
  PolicyEngine,
  ProjectRole,
} from '@sdlc/contracts';

import type { Intent } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { gatherG6Facts, type G6Facts } from './g6-ci.js';
import { returnedFromG5 } from './g5-scope.js';

/** What the resolution of `gate` reads from the database, besides the intent. */
export interface GateOversightFacts {
  /** The latest plan's change flags (G1–G4, G7, G8). */
  readonly changeFlags: readonly ChangeFlag[];
  /** G3 only: G5, G6 or G7 sent the intent back to G3. */
  readonly returnedFromG5?: boolean;
  /** G6 only: the last CI reading. */
  readonly g6?: G6Facts | null;
}

/** The policy context of G6: the findings counts, and whether they are known (QUESTIONS #157). */
export function g6Context(facts: G6Facts | null | undefined) {
  const ci = facts?.ci ?? null;
  return {
    securityFindings: ci?.counts ?? {},
    securityFindingsUnknown: ci === null || ci.findings !== 'known',
  };
}

/** The oversight of `gate` for an intent that waits there (pure). */
export function resolveGateOversight(
  policy: PolicyEngine,
  intent: Pick<Intent, 'risk_tier'>,
  gate: GateCode,
  facts: GateOversightFacts,
): OversightResolution {
  const riskTier = intent.risk_tier;
  const changeFlags = facts.changeFlags;
  switch (gate) {
    case 'G3':
      return policy.oversightMode({
        gate,
        riskTier,
        changeFlags,
        ...(facts.returnedFromG5 ? { context: { returnedFromG5: true } } : {}),
      });
    case 'G5':
      return policy.oversightMode({
        gate,
        riskTier,
        changeFlags: [],
        context: { breached: false },
      });
    case 'G6':
      return policy.oversightMode({
        gate,
        riskTier,
        changeFlags: [],
        context: g6Context(facts.g6),
      });
    case 'G8':
      return policy.oversightMode({
        gate,
        riskTier,
        changeFlags,
        context: { environment: 'production' },
      });
    default:
      return policy.oversightMode({ gate, riskTier, changeFlags });
  }
}

/** Reads what `resolveGateOversight` needs for `gate` from the database. */
export async function gatherGateOversightFacts(
  tx: TenantScope,
  intent: Pick<Intent, 'id'>,
  gate: GateCode,
): Promise<GateOversightFacts> {
  if (gate === 'G5') return { changeFlags: [] };
  if (gate === 'G6') return { changeFlags: [], g6: await gatherG6Facts(tx, intent.id) };
  const changeFlags = (await tx.plans.latest(intent.id))?.change_flags ?? [];
  if (gate === 'G3') return { changeFlags, returnedFromG5: await returnedFromG5(tx, intent.id) };
  return { changeFlags };
}

/** Gather and resolve in one call (the workflow's G1–G4, G7, G8 steps). */
export async function gateOversight(
  tx: TenantScope,
  policy: PolicyEngine,
  intent: Pick<Intent, 'id' | 'risk_tier'>,
  gate: GateCode,
): Promise<OversightResolution> {
  return resolveGateOversight(
    policy,
    intent,
    gate,
    await gatherGateOversightFacts(tx, intent, gate),
  );
}

/** Who an intent waits for at its current gate (the API's `waiting_for`, QUESTIONS #261). */
export interface WaitingFor {
  readonly gate: GateCode;
  readonly mode: OversightResolution['mode'];
  /** Approvers (HITL) or the people told (HOTL, AUDIT); never `viewer`. Empty for POLICY. */
  readonly roles: readonly ProjectRole[];
  readonly approvalsNeeded: number;
}

/**
 * The oversight of the gate an intent waits at: who decides it (HITL approvers, HOTL or AUDIT
 * roles told, POLICY: the platform). It does not say whether a platform check holds the gate
 * right now (a failed G4 check, a plan to submit again, a freezing escalation, a merge to come):
 * those are the workflow's waiting reasons, never copied here (ADR-M54 §2.4).
 * Null when nothing is certain: the intent
 * does not wait at a gate (`in_gate`), or it waits at G6 for CI (the workflow resolves G6's
 * oversight only once CI passed; before that the platform, not a person, is waited for).
 */
export async function currentGateWaitingFor(
  tx: TenantScope,
  policy: PolicyEngine,
  intent: Pick<Intent, 'id' | 'risk_tier' | 'status' | 'current_gate'>,
): Promise<WaitingFor | null> {
  const gate = intent.current_gate;
  if (intent.status !== 'in_gate' || gate === null) return null;
  const facts = await gatherGateOversightFacts(tx, intent, gate);
  if (gate === 'G6' && facts.g6?.ci?.state !== 'passed') return null;
  const oversight = resolveGateOversight(policy, intent, gate, facts);
  return {
    gate,
    mode: oversight.mode,
    roles: oversight.roles.filter((role) => role !== 'viewer'),
    approvalsNeeded: oversight.approvalsNeeded,
  };
}
