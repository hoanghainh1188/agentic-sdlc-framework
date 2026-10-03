// Who approves what in the agent register (handbook Ch.20 §20.7, §20.9, §20.11; task B13 AC7).
//
// TIME-LIMITED EXCEPTION (QUESTIONS #153, ADR-M37 §2.8): handbook rules belong in configuration
// (CLAUDE.md), but agents belong to the tenant and no tenant-level configuration exists yet. This
// table moves into a tenant configuration once one exists. Until then a change here needs an
// approved handbook change first (CLAUDE.md "Direction").
//
// Capacities: `owner` is the agent's technical owner (`agents.owner_id`). `person_a`, `person_b`
// and `governance` (leadership) are project roles: a person fills one when they hold the role on
// any active project of the tenant (QUESTIONS #153, MVP).
import type { AutonomyLevel } from '@sdlc/contracts';

export const APPROVAL_CAPACITIES = ['owner', 'person_a', 'person_b', 'governance'] as const;
export type ApprovalCapacity = (typeof APPROVAL_CAPACITIES)[number];

export const APPROVAL_PURPOSES = ['activate', 'retire'] as const;
export type ApprovalPurpose = (typeof APPROVAL_PURPOSES)[number];

/** Ch.20 §20.7: approval for use of a new agent, by agent type. L3+ is not in the MVP. */
export const USE_APPROVERS: Readonly<Record<'L0' | 'L1' | 'L2', readonly ApprovalCapacity[]>> = {
  // Reads internal documents only: Person A + technical owner.
  L0: ['person_a', 'owner'],
  // Works in a sandbox, opens PRs: technical owner + Person B.
  L1: ['owner', 'person_b'],
  L2: ['owner', 'person_b'],
};

/**
 * Ch.20 §20.11: change approval (a new version, or an agent back from suspension or quarantine):
 * technical owner + Person B; leadership for L3+ (not in the MVP).
 */
export const CHANGE_APPROVERS: readonly ApprovalCapacity[] = ['owner', 'person_b'];

/** Ch.20 §20.11: retirement: owner + leadership. */
export const RETIRE_APPROVERS: readonly ApprovalCapacity[] = ['owner', 'governance'];

/** Ch.20 §20.9, §20.11: Person B or leadership may suspend or quarantine an agent at any time. */
export const STOP_CAPACITIES: readonly ApprovalCapacity[] = ['person_b', 'governance'];

/** Ch.20 §20.11: the technical owner keeps the register entry and recertifies. */
export const OWNER_CAPACITY: ApprovalCapacity = 'owner';

/**
 * The capacities that must each approve, by a different person. `proposed` → active is the first
 * use (§20.7); `suspended` → active is a change (§20.11).
 */
export function requiredApprovers(
  purpose: ApprovalPurpose,
  agent: { readonly status: string; readonly max_autonomy: AutonomyLevel },
): readonly ApprovalCapacity[] {
  if (purpose === 'retire') return RETIRE_APPROVERS;
  if (agent.status !== 'proposed') return CHANGE_APPROVERS;
  const level = agent.max_autonomy;
  return level === 'L0' || level === 'L1' || level === 'L2' ? USE_APPROVERS[level] : [];
}
