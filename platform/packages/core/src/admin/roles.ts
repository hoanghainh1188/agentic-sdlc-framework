// Project roles (2+N, handbook Ch.5; task B13 AC2, ADR-M37 §2.2). A tenant admin or the project's
// `admin` grants and revokes them. Separation of duties:
// - nobody grants a role to themselves (QUESTIONS #151); the operator command does it on the
//   server for a one-admin tenant;
// - one person never holds both roles of a pair in config `access.conflicting_roles` on the same
//   project (QUESTIONS #154; Person A and Person B always, rule M21).
// A role is revoked by setting `revoked_at`; the binding stays as history (D-05 D7).
import type { ProjectRole } from '@sdlc/contracts';
import { PROJECT_ROLES } from '@sdlc/contracts';

import { DbError } from '../db/errors.js';
import type { RoleBinding } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { isUuid } from '../db/tenant-id.js';
import { loadEffectiveConfig } from '../registry/effective-config.js';
import { auditActor, projectAdminAccess, projectAdminWrite, type AdminActor } from './actor.js';
import { AdminError } from './errors.js';
import { activeProject } from './projects.js';
import { findUser } from './users.js';

export async function listProjectRoles(
  scope: TenantScope,
  actor: AdminActor,
  slug: string,
  includeRevoked = false,
): Promise<{ project: { id: string; slug: string }; bindings: RoleBinding[] }> {
  const { project } = await projectAdminAccess(scope, actor, slug);
  return {
    project: { id: project.id, slug: project.slug },
    bindings: await scope.roleBindings.listForProject(project.id, { includeRevoked }),
  };
}

export interface GrantProjectRole {
  readonly userId: string;
  readonly role: ProjectRole;
}

export async function grantProjectRole(
  scope: TenantScope,
  actor: AdminActor,
  slug: string,
  input: GrantProjectRole,
): Promise<RoleBinding> {
  if (!(PROJECT_ROLES as readonly string[]).includes(input.role)) {
    throw new AdminError('invalid_value', 'unknown project role', { field: 'role' });
  }
  return scope.transaction(async (tx) => {
    await projectAdminWrite(tx, actor, slug);
    const project = await activeProject(tx, slug);
    if (actor.type === 'human' && actor.userId === input.userId) {
      throw new AdminError('self_action', 'nobody grants a role to themselves');
    }
    const user = await findUser(tx, input.userId);
    if (user.status !== 'active') throw new AdminError('user_not_active', 'user is disabled');
    await tx.roleBindings.lockForGrant(project.id);
    const held = (await tx.roleBindings.listForUser(user.id))
      .filter((binding) => binding.project_id === project.id)
      .map((binding) => binding.role);
    const { config } = await loadEffectiveConfig(tx.projectConfigs, project.id);
    const conflict = conflictingRole(config.access.conflicting_roles, held, input.role);
    if (conflict !== undefined) {
      throw new AdminError('conflicting_role', 'the user holds a conflicting role', {
        reason: conflict,
      });
    }
    const binding = await tx.roleBindings
      .grant({ user_id: user.id, project_id: project.id, role: input.role })
      .catch((error: unknown) => {
        throw error instanceof DbError && error.code === 'conflict'
          ? new AdminError('already_exists', 'the user already holds the role')
          : error;
      });
    await tx.audit.append({
      action: 'role.granted',
      ...auditActor(actor),
      entityId: binding.id,
      payload: { user_id: binding.user_id, project_id: binding.project_id, role: binding.role },
    });
    return binding;
  });
}

/** Revokes an active binding of the project. Revoking one's own role is allowed (it only removes power). */
export async function revokeProjectRole(
  scope: TenantScope,
  actor: AdminActor,
  slug: string,
  bindingId: string,
  now?: Date,
): Promise<RoleBinding> {
  return scope.transaction(async (tx) => {
    const project = await projectAdminWrite(tx, actor, slug);
    const binding = isUuid(bindingId) ? await tx.roleBindings.getById(bindingId) : undefined;
    if (binding?.project_id !== project.id) {
      throw new AdminError('role_binding_not_found', 'no active role binding with this ID');
    }
    const revoked = await tx.roleBindings.revoke(binding.id, now);
    if (!revoked) throw new AdminError('role_binding_not_found', 'no active role binding');
    await tx.audit.append({
      action: 'role.revoked',
      ...auditActor(actor),
      entityId: revoked.id,
      payload: { user_id: revoked.user_id, project_id: revoked.project_id, role: revoked.role },
    });
    return revoked;
  });
}

/**
 * The first role the user already holds that conflicts with `role`, or undefined. Exported for
 * tests.
 */
export function conflictingRole(
  pairs: readonly (readonly ProjectRole[])[],
  held: readonly ProjectRole[],
  role: ProjectRole,
): ProjectRole | undefined {
  for (const pair of pairs) {
    if (!pair.includes(role)) continue;
    const other = pair.find((candidate) => candidate !== role && held.includes(candidate));
    if (other !== undefined) return other;
  }
  return undefined;
}
