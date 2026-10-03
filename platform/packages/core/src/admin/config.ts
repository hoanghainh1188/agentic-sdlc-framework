// Project configuration upload and the start-up check after a change of platform defaults
// (task B13 AC4, AC8; ADR-M18, ADR-M37 §2.4–§2.5; QUESTIONS #95).
//
// Upload: `@sdlc/config` validates the YAML (schema and mandatory rules M1–M21) and computes
// `config_hash`. A breach is refused with catalog-keyed issues; loosening warnings are returned
// and recorded in `config.changed` as `<warning>:<path>` codes.
//
// Start-up check: `config_hash` is the hash of the effective configuration (defaults merged with
// the stored YAML), so a release that adds or changes a default changes it for every stored
// configuration. When the stored YAML is unchanged (`override_sha256` still matches), the check
// re-hashes it, saves a new version and appends `config.changed` (actor `system`, cause
// `defaults_changed`). A YAML changed outside the platform, or one the new defaults make invalid,
// is left as is: the project fails closed until a person saves a configuration again.
import { loadProjectConfig, type ConfigIssue } from '@sdlc/config';

import { DbError } from '../db/errors.js';
import type { PlatformLogger } from '../observability/logger.js';
import type { PlatformDatabase } from '../db/platform-database.js';
import { MAX_WARNING_CODES, overrideSha256 } from '../db/repositories/project-configs.js';
import type { Project, ProjectConfig } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import type { TenantId } from '../db/tenant-id.js';
import { projectAdminAccess, projectAdminWrite, type AdminActor } from './actor.js';
import { AdminError } from './errors.js';
import { activeProject } from './projects.js';

/** Largest stored YAML. The request body limit (64 KiB) also holds the JSON around it. */
export const MAX_CONFIG_YAML_BYTES = 32 * 1024;

export interface ProjectConfigView {
  readonly project: Pick<Project, 'id' | 'slug'>;
  /** 0: no stored configuration; the project uses the defaults. */
  readonly version: number;
  readonly configYaml: string;
  readonly configHash: string;
  readonly overrideSha256: string | null;
  readonly updatedBy: string | null;
  readonly updatedAt: Date | null;
  /** Loosening warnings of the configuration in force (empty for the defaults). */
  readonly warnings: readonly ConfigIssue[];
}

/** The project's configuration as stored, for any person with a role on it or a tenant admin. */
export async function showProjectConfig(
  scope: TenantScope,
  actor: AdminActor,
  slug: string,
): Promise<ProjectConfigView> {
  const { project } = await projectAdminAccess(scope, actor, slug);
  const stored = await scope.projectConfigs.get(project.id);
  const loaded = loadProjectConfig(stored?.config_yaml ?? '');
  return view(
    project,
    stored,
    loaded.ok ? loaded.configHash : null,
    loaded.ok ? loaded.warnings : [],
  );
}

export interface SaveConfigInput {
  readonly configYaml: string;
  /** The version read; 0 when the project has no stored configuration. */
  readonly expectedVersion: number;
}

/**
 * Validates and stores a project configuration (tenant admin or the project's `admin`). Refused:
 * `config_rejected` with the issues, `config_version_conflict` for a stale version.
 */
export async function saveProjectConfig(
  scope: TenantScope,
  actor: AdminActor,
  slug: string,
  input: SaveConfigInput,
): Promise<ProjectConfigView> {
  if (Buffer.byteLength(input.configYaml, 'utf8') > MAX_CONFIG_YAML_BYTES) {
    throw new AdminError('invalid_value', 'configuration too large', { field: 'config_yaml' });
  }
  return scope.transaction(async (tx) => {
    // Permission first: a caller without it learns nothing about the configuration.
    await projectAdminWrite(tx, actor, slug);
    const project = await activeProject(tx, slug);
    const loaded = loadProjectConfig(input.configYaml);
    if (!loaded.ok) {
      throw new AdminError('config_rejected', 'the configuration is refused', {
        issues: loaded.errors,
      });
    }
    const codes = warningCodes(loaded.warnings);
    try {
      const saved = await tx.projectConfigs.save(project.id, {
        configYaml: input.configYaml,
        configHash: loaded.configHash,
        updatedBy: actor.type === 'human' ? actor.userId : null,
        expectedVersion: input.expectedVersion,
        cause: 'upload',
        warnings: codes,
        warningCount: loaded.warnings.length,
      });
      return view(project, saved, saved.config_hash, loaded.warnings);
    } catch (error) {
      if (error instanceof DbError && error.code === 'version_conflict') {
        throw new AdminError('config_version_conflict', 'the configuration changed');
      }
      throw error;
    }
  });
}

/**
 * Audit codes of loosening warnings: `<warning>:<path>` (for example
 * `mode_loosened:oversight.matrix.G2.medium.mode`), cut to the audit code format, at most
 * `MAX_WARNING_CODES`. The count is recorded separately.
 */
export function warningCodes(warnings: readonly ConfigIssue[]): string[] {
  return warnings.slice(0, MAX_WARNING_CODES).map((warning) => {
    const name = warning.key.replace(/^config\.warning\./, '');
    const raw = `${name}:${warning.path}`.replace(/[^A-Za-z0-9_.:-]/g, '_');
    return raw.slice(0, 64);
  });
}

export type ReconcileOutcome =
  /** The stored hash is still right. */
  | 'unchanged'
  /** Only the defaults changed: re-hashed and saved as a new version. */
  | 'rehashed'
  /** Another process re-hashed it first. */
  | 'raced'
  /** The stored YAML is not the one saved (changed outside the platform): left as is. */
  | 'override_changed'
  /** The new defaults make the stored YAML invalid: left as is, the project fails closed. */
  | 'config_invalid';

export interface ReconcileResult {
  readonly tenantId: TenantId;
  readonly projectId: string;
  readonly outcome: ReconcileOutcome;
  /** The new version, for `rehashed`. */
  readonly version?: number;
}

/**
 * The start-up check of B13 AC8, for every stored configuration of every tenant. The api and the
 * worker run it before they serve; a compare-and-set on the version makes two at once safe.
 */
export async function reconcileStoredConfigs(db: PlatformDatabase): Promise<ReconcileResult[]> {
  const results: ReconcileResult[] = [];
  for (const tenant of await db.system.listTenants()) {
    const scope = db.forTenant(tenant.id as TenantId);
    for (const stored of await scope.projectConfigs.list()) {
      results.push({
        tenantId: scope.tenantId,
        projectId: stored.project_id,
        ...(await reconcileOne(scope, stored)),
      });
    }
  }
  return results;
}

/**
 * Runs `reconcileStoredConfigs` and logs one line per stored configuration that changed or stays
 * refused (IDs and codes only). Never throws: a failed check only means projects fail closed.
 */
export async function checkStoredConfigsAtStart(
  db: PlatformDatabase,
  log: PlatformLogger,
): Promise<void> {
  try {
    for (const result of await reconcileStoredConfigs(db)) {
      if (result.outcome === 'unchanged' || result.outcome === 'raced') continue;
      log.log(result.outcome === 'rehashed' ? 'info' : 'warn', `config.${result.outcome}`, {
        tenantId: result.tenantId,
        projectId: result.projectId,
        ...(result.version === undefined ? {} : { version: result.version }),
      });
    }
  } catch (error) {
    log.log('error', 'config.check_failed', {
      error: error instanceof Error ? error.name : typeof error,
    });
  }
}

async function reconcileOne(
  scope: TenantScope,
  stored: ProjectConfig,
): Promise<{ outcome: ReconcileOutcome; version?: number }> {
  if (overrideSha256(stored.config_yaml) !== stored.override_sha256) {
    return { outcome: 'override_changed' };
  }
  const loaded = loadProjectConfig(stored.config_yaml);
  if (!loaded.ok) return { outcome: 'config_invalid' };
  if (loaded.configHash === stored.config_hash) return { outcome: 'unchanged' };
  try {
    const saved = await scope.projectConfigs.save(stored.project_id, {
      configYaml: stored.config_yaml,
      configHash: loaded.configHash,
      updatedBy: null,
      expectedVersion: stored.version,
      cause: 'defaults_changed',
      warnings: warningCodes(loaded.warnings),
      warningCount: loaded.warnings.length,
    });
    return { outcome: 'rehashed', version: saved.version };
  } catch (error) {
    if (error instanceof DbError && error.code === 'version_conflict') return { outcome: 'raced' };
    throw error;
  }
}

function view(
  project: Pick<Project, 'id' | 'slug'>,
  stored: ProjectConfig | undefined,
  effectiveHash: string | null,
  warnings: readonly ConfigIssue[],
): ProjectConfigView {
  return {
    project: { id: project.id, slug: project.slug },
    version: stored?.version ?? 0,
    configYaml: stored?.config_yaml ?? '',
    configHash: stored?.config_hash ?? effectiveHash ?? '',
    overrideSha256: stored?.override_sha256 ?? null,
    updatedBy: stored?.updated_by ?? null,
    updatedAt: stored?.created_at ?? null,
    warnings,
  };
}
