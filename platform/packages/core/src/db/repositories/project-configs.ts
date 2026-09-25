import type { Kysely } from 'kysely';

import { DbError } from '../errors.js';
import type { Database, ProjectConfig } from '../schema.js';
import { AuditLogRepository } from './audit-log.js';
import { TenantRepository } from './base.js';
import { assertExpectedVersion, versionConflict } from './versioned.js';

export interface SaveProjectConfig {
  readonly configYaml: string;
  /** Computed by the config package (A05). Stored as given: its definition belongs to A05. */
  readonly configHash: string;
  /** Null when the platform writes the config itself. */
  readonly updatedBy: string | null;
  /** Version the caller read; 0 when the project has no config yet. */
  readonly expectedVersion: number;
}

export class ProjectConfigRepository extends TenantRepository {
  get(projectId: string): Promise<ProjectConfig | undefined> {
    return this.run(
      this.db
        .selectFrom('project_configs')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('project_id', '=', projectId)
        .executeTakeFirst(),
    );
  }

  /**
   * Creates version 1, or replaces version N with N + 1. In the same transaction, appends a
   * `config.changed` audit event with the new version and `config_hash` (never the config text).
   */
  async save(projectId: string, input: SaveProjectConfig): Promise<ProjectConfig> {
    assertExpectedVersion(input.expectedVersion);
    if (!/^[0-9a-f]{64}$/.test(input.configHash)) {
      throw new DbError('invalid_value', 'configHash must be a SHA-256 hex digest');
    }
    return this.transactional(async (db) => {
      const saved = await this.write(db, projectId, input);
      await new AuditLogRepository(db, this.tenantId).append({
        action: 'config.changed',
        actorType: saved.updated_by === null ? 'system' : 'human',
        actorId: saved.updated_by,
        entityId: saved.project_id,
        payload: { version: saved.version, config_hash: saved.config_hash },
      });
      return saved;
    });
  }

  private async write(
    db: Kysely<Database>,
    projectId: string,
    input: SaveProjectConfig,
  ): Promise<ProjectConfig> {
    const values = {
      config_yaml: input.configYaml,
      config_hash: input.configHash,
      updated_by: input.updatedBy,
      version: input.expectedVersion + 1,
    };
    if (input.expectedVersion === 0) {
      return this.run(
        db
          .insertInto('project_configs')
          .values({ ...values, tenant_id: this.tenantId, project_id: projectId })
          .returningAll()
          .executeTakeFirstOrThrow(),
      ).catch((error: unknown) => {
        throw error instanceof DbError && error.code === 'conflict'
          ? versionConflict('project_configs', 0)
          : error;
      });
    }
    const updated = await this.run(
      db
        .updateTable('project_configs')
        .set(values)
        .where('tenant_id', '=', this.tenantId)
        .where('project_id', '=', projectId)
        .where('version', '=', input.expectedVersion)
        .returningAll()
        .executeTakeFirst(),
    );
    if (!updated) throw versionConflict('project_configs', input.expectedVersion);
    return updated;
  }
}
