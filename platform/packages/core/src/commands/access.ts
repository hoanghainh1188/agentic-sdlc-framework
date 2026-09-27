// Who may read and create intents of a project (task B03, QUESTIONS.md #66, ADR-M26 section 2.5).
// The roles come from the project configuration (`access.*`), never from code.
import type { ProjectRole } from '@sdlc/contracts';

import type { TenantScope } from '../db/tenant-scope.js';
import { loadEffectiveConfig } from '../registry/effective-config.js';

export interface ProjectAccess {
  /** Active roles of the actor on the project. Empty: the project is invisible to the actor. */
  readonly roles: readonly ProjectRole[];
  readonly canRead: boolean;
  readonly canCreateIntent: boolean;
}

/** No active role → nothing. Creators always read (config `access.intent_create_roles`). */
export async function projectAccess(
  scope: TenantScope,
  projectId: string,
  userId: string,
): Promise<ProjectAccess> {
  const roles = (await scope.roleBindings.listForUser(userId))
    .filter((binding) => binding.project_id === projectId)
    .map((binding) => binding.role);
  if (roles.length === 0) return { roles, canRead: false, canCreateIntent: false };
  const { config } = await loadEffectiveConfig(scope.projectConfigs, projectId);
  const canCreateIntent = roles.some((role) => config.access.intent_create_roles.includes(role));
  const canRead =
    canCreateIntent || roles.some((role) => config.access.intent_read_roles.includes(role));
  return { roles, canRead, canCreateIntent };
}
