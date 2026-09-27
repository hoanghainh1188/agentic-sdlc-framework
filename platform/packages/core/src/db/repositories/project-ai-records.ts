import type { DataClass } from '@sdlc/contracts';
import { sql, type Kysely } from 'kysely';

import { AiRecordError } from '../../ai-record/errors.js';
import {
  aiRecordSha256,
  aiRecordViolation,
  consentOf,
  sortDataClasses,
  type AiRecordContent,
} from '../../ai-record/rules.js';
import { DbError } from '../errors.js';
import type { Database, ProjectAiRecord, ProjectAiRecordVersion } from '../schema.js';
import { AuditLogRepository } from './audit-log.js';
import { TenantRepository } from './base.js';
import { assertExpectedVersion, versionConflict } from './versioned.js';

export interface SaveProjectAiRecord extends AiRecordContent {
  /** The person accountable for this version: a user of the tenant. */
  readonly updatedBy: string;
  /** Version the caller read; 0 when the project has no AI record yet. */
  readonly expectedVersion: number;
  /**
   * Who records the change in the audit log: `human` (the API: `updatedBy` is the logged-in
   * user) or `system` (the operator's `sdlc admin ai-record` command, on behalf of `updatedBy`).
   */
  readonly actorType: 'human' | 'system';
  /** Today (`YYYY-MM-DD`, UTC) for the confirmation-date check. Default: the current date. */
  readonly today?: string;
}

const SCALAR_COLUMNS = [
  'project_id',
  'tenant_id',
  'version',
  'ai_allowed',
  'prod_logs_allowed',
  'disclosure_format',
  'confirmed_at',
  'record_ref',
  'record_sha256',
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

  /** Every version of the record, oldest first (ADR-M32 §2.3). */
  versions(projectId: string): Promise<ProjectAiRecordVersion[]> {
    return this.run(
      this.db
        .selectFrom('project_ai_record_versions')
        .select([
          'tenant_id',
          'project_id',
          'version',
          'ai_allowed',
          'prod_logs_allowed',
          'disclosure_format',
          'confirmed_at',
          'record_ref',
          'record_sha256',
          'updated_by',
          'created_at',
          allowedDataClasses,
        ])
        .where('tenant_id', '=', this.tenantId)
        .where('project_id', '=', projectId)
        .orderBy('version')
        .execute(),
    );
  }

  /**
   * Creates version 1, or replaces version N with N + 1 (compare-and-set). Checks the fixed rules
   * of handbook Chapter 2 first (`AiRecordError`, ADR-M32 §3). A database trigger appends the
   * version to `project_ai_record_versions`. In the same transaction, appends `ai_record.changed`
   * with codes, the version and the record hash only (never the link).
   */
  async save(projectId: string, input: SaveProjectAiRecord): Promise<ProjectAiRecord> {
    assertExpectedVersion(input.expectedVersion);
    const content: AiRecordContent = {
      aiAllowed: input.aiAllowed,
      allowedDataClasses: input.allowedDataClasses,
      prodLogsAllowed: input.prodLogsAllowed,
      disclosureFormat: input.disclosureFormat,
      confirmedAt: input.confirmedAt,
      recordRef: input.recordRef,
    };
    const found = aiRecordViolation(content, input.today ?? new Date().toISOString().slice(0, 10));
    if (found) {
      throw new AiRecordError(
        found.violation,
        `project AI record: ${found.violation}`,
        found.field,
      );
    }
    return this.transactional(async (db) => {
      const saved = await this.write(db, projectId, input, content);
      await new AuditLogRepository(db, this.tenantId).append({
        action: 'ai_record.changed',
        actorType: input.actorType,
        actorId: input.actorType === 'human' ? saved.updated_by : null,
        entityId: saved.project_id,
        payload: {
          version: saved.version,
          record_sha256: saved.record_sha256,
          ai_allowed: saved.ai_allowed,
          prod_logs_allowed: saved.prod_logs_allowed,
          disclosure_format: saved.disclosure_format,
          consent: consentOf(saved.confirmed_at),
          updated_by: saved.updated_by,
        },
      });
      return saved;
    });
  }

  private async write(
    db: Kysely<Database>,
    projectId: string,
    input: SaveProjectAiRecord,
    content: AiRecordContent,
  ): Promise<ProjectAiRecord> {
    const values = {
      version: input.expectedVersion + 1,
      ai_allowed: content.aiAllowed,
      allowed_data_classes: sortDataClasses(content.allowedDataClasses),
      prod_logs_allowed: content.prodLogsAllowed,
      disclosure_format: content.disclosureFormat,
      confirmed_at: content.confirmedAt,
      record_ref: content.recordRef,
      record_sha256: aiRecordSha256(content),
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
