// Who may build and read an intent's Evidence Pack (task E02, design/ADR-M48, QUESTIONS #218).
// - Tenant admins always may.
// - Otherwise a role on the intent's project in config `access.evidence_build_roles` (build) or
//   `access.evidence_read_roles` (list, show, export); never `viewer` (mandatory rule M30).
// - No role on the project: the intent is not found (ADR-M26 §2.5); another role: forbidden.
// - The platform itself (E03 at G8) passes: actor `system`.
import { isTenantAdmin } from '../admin/actor.js';
import { CommandError } from '../commands/errors.js';
import type { Intent, Project } from '../db/schema.js';
import { isUuid } from '../db/tenant-id.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { loadEffectiveConfig } from '../registry/effective-config.js';

export type EvidenceActor =
  { readonly type: 'human'; readonly userId: string } | { readonly type: 'system' };

export type EvidenceAccess = 'build' | 'read';

export interface EvidenceSubject {
  readonly intent: Intent;
  readonly project: Project;
}

export async function resolveEvidenceSubject(
  scope: TenantScope,
  actor: EvidenceActor,
  /** The intent's code (`INT-…`) or ID. */
  intentRef: string,
  access: EvidenceAccess,
): Promise<EvidenceSubject> {
  const intent = isUuid(intentRef)
    ? await scope.intents.getById(intentRef)
    : await scope.intents.getByCode(intentRef);
  if (!intent) throw new CommandError('intent_not_found', `intent ${intentRef} not found`);
  const project = await scope.projects.getById(intent.project_id);
  if (!project) throw new CommandError('intent_not_found', `intent ${intentRef} not found`);
  if (actor.type === 'system' || (await isTenantAdmin(scope, actor.userId))) {
    return { intent, project };
  }
  const roles = (await scope.roleBindings.listForUser(actor.userId))
    .filter((binding) => binding.project_id === project.id)
    .map((binding) => binding.role);
  if (roles.length === 0) {
    throw new CommandError('intent_not_found', 'intent_not_found: no role on the project');
  }
  const { config } = await loadEffectiveConfig(scope.projectConfigs, project.id);
  const allowed =
    access === 'build' ? config.access.evidence_build_roles : config.access.evidence_read_roles;
  if (!roles.some((role) => allowed.includes(role))) {
    throw new CommandError('forbidden', `no role in access.evidence_${access}_roles`);
  }
  return { intent, project };
}
