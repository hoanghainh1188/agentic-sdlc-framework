// Who receives an escalation (handbook Ch.6 §6.4 "Who receives it", §6.5; QUESTIONS #74,
// design/ADR-M28 §2.1).
//
// - The roles come from the project configuration (`escalation.routing.<route>`); governance is
//   always the last step (rule M17). Nothing here names a role for a route.
// - The holder of a role is the person with the earliest active binding for it on the project,
//   whose user is active. Revoked bindings and disabled users never count.
// - Producers of the change are never chosen (FR-18: authority never passes back to them). The
//   owner is never also the backup.
// - A role with no holder leaves its step empty: the clock skips it. When nobody holds any of the
//   three roles, the escalation is "unrouted" and stays frozen at the governance step.
import type { EscalationRouting, EscalationStep, ProjectRole } from '@sdlc/contracts';

import type { RoleBinding } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';

export const GOVERNANCE_ROLE: ProjectRole = 'governance';

export interface EscalationHolders {
  readonly ownerId: string | null;
  readonly backupOwnerId: string | null;
  /** Someone other than a producer holds the governance role. */
  readonly hasGovernance: boolean;
}

/** The holder of `role`: the earliest active binding of an active user who is not excluded. */
export function pickHolder(
  bindings: readonly RoleBinding[],
  activeUsers: ReadonlySet<string>,
  role: ProjectRole,
  excluded: ReadonlySet<string>,
): string | null {
  const candidates = bindings
    .filter((b) => b.role === role && b.revoked_at === null)
    .filter((b) => activeUsers.has(b.user_id) && !excluded.has(b.user_id))
    .sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || a.id.localeCompare(b.id));
  return candidates[0]?.user_id ?? null;
}

/** Owner, backup and governance holders from the bindings (pure). */
export function holdersFrom(
  bindings: readonly RoleBinding[],
  activeUsers: ReadonlySet<string>,
  routing: EscalationRouting,
  producers: readonly string[],
): EscalationHolders {
  const excluded = new Set(producers);
  const ownerId = pickHolder(bindings, activeUsers, routing.owner_role, excluded);
  const withoutOwner = ownerId === null ? excluded : new Set([...excluded, ownerId]);
  const backupOwnerId =
    routing.backup_role === null
      ? null
      : pickHolder(bindings, activeUsers, routing.backup_role, withoutOwner);
  const hasGovernance = pickHolder(bindings, activeUsers, GOVERNANCE_ROLE, excluded) !== null;
  return { ownerId, backupOwnerId, hasGovernance };
}

/** The first step that has a holder; `governance` when none has (unrouted, still frozen). */
export function firstStep(holders: EscalationHolders): EscalationStep {
  if (holders.ownerId !== null) return 'owner';
  if (holders.backupOwnerId !== null) return 'backup';
  return 'governance';
}

export function isUnrouted(holders: EscalationHolders): boolean {
  return holders.ownerId === null && holders.backupOwnerId === null && !holders.hasGovernance;
}

/** The role that holds a step of a route. */
export function stepRole(step: EscalationStep, routing: EscalationRouting): ProjectRole {
  if (step === 'owner') return routing.owner_role;
  if (step === 'backup') return routing.backup_role ?? GOVERNANCE_ROLE;
  return GOVERNANCE_ROLE;
}

interface ProjectHolders {
  readonly bindings: readonly RoleBinding[];
  readonly activeUsers: ReadonlySet<string>;
}

async function loadHolders(scope: TenantScope, projectId: string): Promise<ProjectHolders> {
  const bindings = await scope.roleBindings.listForProject(projectId);
  const userIds = [...new Set(bindings.map((b) => b.user_id))];
  const users = await Promise.all(userIds.map((id) => scope.users.getById(id)));
  const activeUsers = new Set(
    users.flatMap((user) => (user?.status === 'active' ? [user.id] : [])),
  );
  return { bindings, activeUsers };
}

/** Reads the project's active bindings and their active users, then picks the holders. */
export async function resolveHolders(
  scope: TenantScope,
  projectId: string,
  routing: EscalationRouting,
  producers: readonly string[],
): Promise<EscalationHolders> {
  const { bindings, activeUsers } = await loadHolders(scope, projectId);
  return holdersFrom(bindings, activeUsers, routing, producers);
}

/**
 * The backup holder now, just before the owner step runs out: roles can change hands while an
 * escalation waits. Never a producer and never the owner.
 */
export async function currentBackup(
  scope: TenantScope,
  projectId: string,
  routing: EscalationRouting,
  excluded: readonly string[],
): Promise<string | null> {
  if (routing.backup_role === null) return null;
  const { bindings, activeUsers } = await loadHolders(scope, projectId);
  return pickHolder(bindings, activeUsers, routing.backup_role, new Set(excluded));
}
