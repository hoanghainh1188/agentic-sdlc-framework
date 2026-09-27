// Reading and saving the project AI record (task B12, design/ADR-M32 §2.4). The API and the
// operator command both save through `saveAiRecord`; the workflow (G1) and later C06 (G4), E02 and
// E03 (disclosure format) read it through `loadAiRecordFacts`.
import type { ProjectAiFacts, ProjectRole } from '@sdlc/contracts';

import { DbError } from '../db/errors.js';
import type { SaveProjectAiRecord } from '../db/repositories/project-ai-records.js';
import type { ProjectAiRecord } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { loadEffectiveConfig } from '../registry/effective-config.js';
import { AiRecordError } from './errors.js';
import { consentOf, sortDataClasses } from './rules.js';

export function aiRecordFacts(record: ProjectAiRecord): ProjectAiFacts {
  return {
    version: record.version,
    recordSha256: record.record_sha256,
    aiAllowed: record.ai_allowed,
    allowedDataClasses: sortDataClasses(record.allowed_data_classes),
    prodLogsAllowed: record.prod_logs_allowed,
    disclosureFormat: record.disclosure_format,
    consent: consentOf(record.confirmed_at),
  };
}

/** The facts of the project's AI record, or null when the project has none. */
export async function loadAiRecordFacts(
  scope: TenantScope,
  projectId: string,
): Promise<ProjectAiFacts | null> {
  const record = await scope.projectAiRecords.get(projectId);
  return record ? aiRecordFacts(record) : null;
}

export interface AiRecordAccess {
  /** Active roles of the user on the project. Empty: the record is invisible to the user. */
  readonly roles: readonly ProjectRole[];
  readonly canRead: boolean;
  readonly canWrite: boolean;
}

/**
 * Who may read and write the project AI record: config `access.ai_record_write_roles` and
 * `access.ai_record_read_roles` (QUESTIONS.md #103). Writers always read.
 */
export async function aiRecordAccess(
  scope: TenantScope,
  projectId: string,
  userId: string,
): Promise<AiRecordAccess> {
  const roles = (await scope.roleBindings.listForUser(userId))
    .filter((binding) => binding.project_id === projectId)
    .map((binding) => binding.role);
  if (roles.length === 0) return { roles, canRead: false, canWrite: false };
  const { config } = await loadEffectiveConfig(scope.projectConfigs, projectId);
  const canWrite = roles.some((role) => config.access.ai_record_write_roles.includes(role));
  const canRead =
    canWrite || roles.some((role) => config.access.ai_record_read_roles.includes(role));
  return { roles, canRead, canWrite };
}

/**
 * Saves a new version of the record. `updatedBy` must be an active user holding a write role on
 * the project (`not_a_writer`): with `actorType: 'system'` the operator records a change on behalf
 * of that accountable person. A version conflict becomes `AiRecordError('version_conflict')`.
 */
export async function saveAiRecord(
  scope: TenantScope,
  projectId: string,
  input: SaveProjectAiRecord,
): Promise<ProjectAiRecord> {
  return scope.transaction(async (tx) => {
    const user = await tx.users.getById(input.updatedBy);
    const access = await aiRecordAccess(tx, projectId, input.updatedBy);
    if (user?.status !== 'active' || !access.canWrite) {
      throw new AiRecordError('not_a_writer', 'the user holds no write role on the project');
    }
    try {
      return await tx.projectAiRecords.save(projectId, input);
    } catch (error) {
      if (error instanceof DbError && error.code === 'version_conflict') {
        throw new AiRecordError('version_conflict', error.message);
      }
      throw error;
    }
  });
}
