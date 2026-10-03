// Who does an admin change, and may they (task B13, QUESTIONS #150, ADR-M37 §2.1).
// A person acts through the API with their own token. The operator acts on the server with the
// database (`sdlc admin bootstrap`, later `sdlc ops …`): actor `system`, no role check, and the
// audit event has no actor ID (ADR-M26 §2.2). Separation-of-duties rules apply to both.
import type { Project } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import type { AuditEvent } from '../db/repositories/audit-log.js';
import { AdminError } from './errors.js';

export type AdminActor =
  { readonly type: 'human'; readonly userId: string } | { readonly type: 'system' };

export const SYSTEM_ACTOR: AdminActor = { type: 'system' };

/** The audit actor fields of an admin change. */
export function auditActor(actor: AdminActor): Pick<AuditEvent, 'actorType' | 'actorId'> {
  return actor.type === 'human'
    ? { actorType: 'human', actorId: actor.userId }
    : { actorType: 'system', actorId: null };
}

/** True when the person holds the active tenant role `tenant_admin`. */
export async function isTenantAdmin(scope: TenantScope, userId: string): Promise<boolean> {
  return scope.tenantRoles.holds(userId, 'tenant_admin');
}

/** Refuses a person who is not a tenant admin (`forbidden`). The operator always passes. */
export async function assertTenantAdmin(scope: TenantScope, actor: AdminActor): Promise<void> {
  if (actor.type === 'system') return;
  if (!(await isTenantAdmin(scope, actor.userId))) {
    throw new AdminError('forbidden', 'the actor is not a tenant admin');
  }
}

export interface ProjectAdminAccess {
  readonly project: Project;
  /** May read the project's roles and configuration: any active role, or a tenant admin. */
  readonly canRead: boolean;
  /** May change them: a tenant admin, or the project role `admin` (ADR-M37 §2.1). */
  readonly canWrite: boolean;
}

/**
 * Finds the project by slug and what the actor may do with its roles and configuration. A person
 * with no role on the project who is not a tenant admin gets `project_not_found`, like an unknown
 * project (ADR-M26 §2.5).
 */
export async function projectAdminAccess(
  scope: TenantScope,
  actor: AdminActor,
  slug: string,
): Promise<ProjectAdminAccess> {
  const project = await scope.projects.getBySlug(slug);
  if (!project) throw new AdminError('project_not_found', `project ${slug} not found`);
  if (actor.type === 'system') return { project, canRead: true, canWrite: true };
  if (await isTenantAdmin(scope, actor.userId)) return { project, canRead: true, canWrite: true };
  const roles = (await scope.roleBindings.listForUser(actor.userId))
    .filter((binding) => binding.project_id === project.id)
    .map((binding) => binding.role);
  if (roles.length === 0) throw new AdminError('project_not_found', `project ${slug} not found`);
  return { project, canRead: true, canWrite: roles.includes('admin') };
}

/** Like `projectAdminAccess`, but refuses an actor who may only read (`forbidden`). */
export async function projectAdminWrite(
  scope: TenantScope,
  actor: AdminActor,
  slug: string,
): Promise<Project> {
  const access = await projectAdminAccess(scope, actor, slug);
  if (!access.canWrite) {
    throw new AdminError('forbidden', 'the actor may not change the project roles or config');
  }
  return access.project;
}
