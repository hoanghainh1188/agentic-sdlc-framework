import { DbError } from '../errors.js';
import type { ProjectConfig } from '../schema.js';
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

  /** Creates version 1, or replaces version N with N + 1. History goes to the audit log (A07). */
  async save(projectId: string, input: SaveProjectConfig): Promise<ProjectConfig> {
    assertExpectedVersion(input.expectedVersion);
    if (!/^[0-9a-f]{64}$/.test(input.configHash)) {
      throw new DbError('invalid_value', 'configHash must be a SHA-256 hex digest');
    }
    const values = {
      config_yaml: input.configYaml,
      config_hash: input.configHash,
      updated_by: input.updatedBy,
      version: input.expectedVersion + 1,
    };
    if (input.expectedVersion === 0) {
      return this.run(
        this.db
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
      this.db
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
