import type { DataClass } from '@sdlc/contracts';
import { sql, type Kysely } from 'kysely';

import { DbError } from '../errors.js';
import type { Database, ProjectAiRecord } from '../schema.js';
import type { AiAllowed, DisclosureFormat, ProdLogsAllowed } from '../vocabulary.js';
import { AuditLogRepository } from './audit-log.js';
import { TenantRepository } from './base.js';
import { assertExpectedVersion, versionConflict } from './versioned.js';

export interface SaveProjectAiRecord {
  readonly aiAllowed: AiAllowed;
  readonly allowedDataClasses: readonly DataClass[];
  readonly allowedToolsLocations: string | null;
  readonly prodLogsAllowed: ProdLogsAllowed;
  readonly disclosureFormat: DisclosureFormat;
  /** Client contact who confirmed the record; null while consent is unknown. */
  readonly confirmedBy: string | null;
  /** `YYYY-MM-DD`. */
  readonly confirmedAt: string | null;
  readonly updatedBy: string;
  /** Version the caller read; 0 when the project has no AI record yet. */
  readonly expectedVersion: number;
}

const SCALAR_COLUMNS = [
  'project_id',
  'tenant_id',
  'version',
  'ai_allowed',
  'allowed_tools_locations',
  'prod_logs_allowed',
  'disclosure_format',
  'confirmed_by',
  'confirmed_at',
  'updated_by',
  'created_at',
] as const;
// `pg` does not parse arrays of custom enum types; read them as text[].
const allowedDataClasses = sql<DataClass[]>`allowed_data_classes::text[]`.as(
  'allowed_data_classes',
);

export class ProjectAiRecordRepository extends TenantRepository {
  get(projectId: string): Promise<ProjectAiRecord | undefined> {
    return this.run(
      this.db
        .selectFrom('project_ai_records')
        .select([...SCALAR_COLUMNS, allowedDataClasses])
        .where('tenant_id', '=', this.tenantId)
        .where('project_id', '=', projectId)
        .executeTakeFirst(),
    );
  }

  /**
   * Creates version 1, or replaces version N with N + 1. Checks at G1 belong to B12. In the same
   * transaction, appends an `ai_record.changed` audit event with the new version only (never the
   * record contents: client names and consent details stay out of the audit log).
   */
  async save(projectId: string, input: SaveProjectAiRecord): Promise<ProjectAiRecord> {
    assertExpectedVersion(input.expectedVersion);
    return this.transactional(async (db) => {
      const saved = await this.write(db, projectId, input);
      await new AuditLogRepository(db, this.tenantId).append({
        action: 'ai_record.changed',
        actorType: 'human',
        actorId: saved.updated_by,
        entityId: saved.project_id,
        payload: { version: saved.version },
      });
      return saved;
    });
  }

  private async write(
    db: Kysely<Database>,
    projectId: string,
    input: SaveProjectAiRecord,
  ): Promise<ProjectAiRecord> {
    const values = {
      version: input.expectedVersion + 1,
      ai_allowed: input.aiAllowed,
      allowed_data_classes: [...input.allowedDataClasses],
      allowed_tools_locations: input.allowedToolsLocations,
      prod_logs_allowed: input.prodLogsAllowed,
      disclosure_format: input.disclosureFormat,
      confirmed_by: input.confirmedBy,
      confirmed_at: input.confirmedAt,
      updated_by: input.updatedBy,
    };
    if (input.expectedVersion === 0) {
      return this.run(
        db
          .insertInto('project_ai_records')
          .values({ ...values, tenant_id: this.tenantId, project_id: projectId })
          .returning([...SCALAR_COLUMNS, allowedDataClasses])
          .executeTakeFirstOrThrow(),
      ).catch((error: unknown) => {
        throw error instanceof DbError && error.code === 'conflict'
          ? versionConflict('project_ai_records', 0)
          : error;
      });
    }
    const updated = await this.run(
      db
        .updateTable('project_ai_records')
        .set(values)
        .where('tenant_id', '=', this.tenantId)
        .where('project_id', '=', projectId)
        .where('version', '=', input.expectedVersion)
        .returning([...SCALAR_COLUMNS, allowedDataClasses])
        .executeTakeFirst(),
    );
    if (!updated) throw versionConflict('project_ai_records', input.expectedVersion);
    return updated;
  }
}
