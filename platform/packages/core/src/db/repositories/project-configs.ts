import { createHash } from 'node:crypto';

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
  /**
   * Why the configuration changed (B13): `upload` (a person or the operator stored a YAML) or
   * `defaults_changed` (the platform re-hashed it after its defaults changed, QUESTIONS #95).
   * Recorded in `config.changed`; left out by callers before B13.
   */
  readonly cause?: ConfigChangeCause;
  /**
   * Codes of the loosening warnings (ADR-M18 §2.4), at most `MAX_WARNING_CODES`; recorded in
   * `config.changed` with their count (D-08 B13 AC4).
   */
  readonly warnings?: readonly string[];
  readonly warningCount?: number;
}

export type ConfigChangeCause = 'upload' | 'defaults_changed';

/** At most this many warning codes go into one `config.changed` event (payload size limit). */
export const MAX_WARNING_CODES = 16;

/** SHA-256 (hex) of the stored YAML text, UTF-8 (B13, QUESTIONS #95). */
export function overrideSha256(configYaml: string): string {
  return createHash('sha256').update(configYaml, 'utf8').digest('hex');
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

  /** Every stored configuration of the tenant (the start-up check of B13 AC8). */
  list(): Promise<ProjectConfig[]> {
    return this.run(
      this.db
        .selectFrom('project_configs')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .orderBy('project_id')
        .execute(),
    );
  }

  /**
   * Creates version 1, or replaces version N with N + 1. In the same transaction, appends a
   * `config.changed` audit event with the new version, `config_hash` and `override_sha256`, the
   * cause and the warning codes (never the config text).
   */
  async save(projectId: string, input: SaveProjectConfig): Promise<ProjectConfig> {
    assertExpectedVersion(input.expectedVersion);
    if (!/^[0-9a-f]{64}$/.test(input.configHash)) {
      throw new DbError('invalid_value', 'configHash must be a SHA-256 hex digest');
    }
    const warnings = input.warnings ?? [];
    const warningCount = input.warningCount ?? warnings.length;
    if (warnings.length > MAX_WARNING_CODES || warningCount < warnings.length) {
      throw new DbError('invalid_value', 'too many warning codes for one config.changed event');
    }
    return this.transactional(async (db) => {
      const saved = await this.write(db, projectId, input);
      await new AuditLogRepository(db, this.tenantId).append({
        action: 'config.changed',
        actorType: saved.updated_by === null ? 'system' : 'human',
        actorId: saved.updated_by,
        entityId: saved.project_id,
        payload: {
          version: saved.version,
          config_hash: saved.config_hash,
          override_sha256: saved.override_sha256,
          ...(input.cause === undefined ? {} : { cause: input.cause }),
          ...(warningCount === 0 ? {} : { warning_count: warningCount, warnings }),
        },
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
      override_sha256: overrideSha256(input.configYaml),
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
