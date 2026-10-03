// Tenant admins (task B13, QUESTIONS #150 option A, ADR-M37 §2.1). A tenant admin manages
// projects, users, identities, tokens and (PR 2) the agent register. Rules:
// - nobody grants a role to themselves (QUESTIONS #151): another tenant admin does, or the operator;
// - the tenant always keeps at least one active tenant admin whose user is active.
import { DbError } from '../db/errors.js';
import type { TenantRoleBinding } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { isUuid } from '../db/tenant-id.js';
import type { TenantRole } from '../db/vocabulary.js';
import { assertTenantAdmin, auditActor, type AdminActor } from './actor.js';
import { AdminError } from './errors.js';

export async function listTenantRoles(
  scope: TenantScope,
  actor: AdminActor,
  includeRevoked = false,
): Promise<TenantRoleBinding[]> {
  await assertTenantAdmin(scope, actor);
  return scope.tenantRoles.list({ includeRevoked });
}

export interface GrantTenantRole {
  readonly userId: string;
  readonly role?: TenantRole;
}

export async function grantTenantRole(
  scope: TenantScope,
  actor: AdminActor,
  input: GrantTenantRole,
): Promise<TenantRoleBinding> {
  const role = input.role ?? 'tenant_admin';
  return scope.transaction(async (tx) => {
    await assertTenantAdmin(tx, actor);
    if (actor.type === 'human' && actor.userId === input.userId) {
      throw new AdminError('self_action', 'nobody grants a role to themselves');
    }
    const user = isUuid(input.userId) ? await tx.users.getById(input.userId) : undefined;
    if (!user) throw new AdminError('user_not_found', 'user not found');
    if (user.status !== 'active') throw new AdminError('user_not_active', 'user is disabled');
    const binding = await tx.tenantRoles
      .grant({ user_id: user.id, role })
      .catch((error: unknown) => {
        throw error instanceof DbError && error.code === 'conflict'
          ? new AdminError('already_exists', 'the user already holds the role')
          : error;
      });
    await tx.audit.append({
      action: 'tenant_role.granted',
      ...auditActor(actor),
      entityId: binding.id,
      payload: { user_id: binding.user_id, role: binding.role },
    });
    return binding;
  });
}

/**
 * Revokes an active tenant role. Refuses to remove the last active tenant admin (whose user is
 * active), also for the operator: grant another one first.
 */
export async function revokeTenantRole(
  scope: TenantScope,
  actor: AdminActor,
  bindingId: string,
  now?: Date,
): Promise<TenantRoleBinding> {
  return scope.transaction(async (tx) => {
    await assertTenantAdmin(tx, actor);
    const binding = isUuid(bindingId) ? await tx.tenantRoles.getById(bindingId) : undefined;
    if (!binding) throw new AdminError('role_binding_not_found', 'no active tenant role');
    if (binding.role === 'tenant_admin') {
      await assertAdminRemains(tx, [binding.user_id]);
    }
    const revoked = await tx.tenantRoles.revoke(binding.id, now);
    if (!revoked) throw new AdminError('role_binding_not_found', 'no active tenant role');
    await tx.audit.append({
      action: 'tenant_role.revoked',
      ...auditActor(actor),
      entityId: revoked.id,
      payload: { user_id: revoked.user_id, role: revoked.role },
    });
    return revoked;
  });
}

/**
 * Refuses a change that would leave no active tenant admin once the given users lose the role
 * (or are disabled). Locks the tenant's admin bindings until the transaction ends, so two
 * concurrent changes cannot each remove the other.
 */
export async function assertAdminRemains(
  scope: TenantScope,
  losingUserIds: readonly string[],
): Promise<void> {
  const bindings = await scope.tenantRoles.lockActive('tenant_admin');
  let remaining = 0;
  for (const binding of bindings) {
    if (losingUserIds.includes(binding.user_id)) continue;
    const user = await scope.users.getById(binding.user_id);
    if (user?.status === 'active') remaining += 1;
  }
  if (remaining === 0) {
    throw new AdminError('last_tenant_admin', 'the tenant would have no active tenant admin');
  }
}
