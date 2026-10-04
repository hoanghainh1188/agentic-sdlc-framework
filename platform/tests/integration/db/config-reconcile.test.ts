// D-08 B13 AC8 (QUESTIONS #95) on a live PostgreSQL: a stored configuration whose hash differs
// only because the platform defaults changed is re-hashed, saved as a new version with
// `config.changed` (actor system, cause `defaults_changed`) and used; a YAML changed outside the
// platform, or one the defaults make invalid, stays refused. A release that changes a default is
// simulated by writing an old `config_hash` next to an unchanged YAML.
import { createHash } from 'node:crypto';

import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { bootstrapTenant } from '../../../packages/core/src/admin/bootstrap.js';
import {
  checkStoredConfigsAtStart,
  reconcileStoredConfigs,
  saveProjectConfig,
} from '../../../packages/core/src/admin/config.js';
import { SYSTEM_ACTOR } from '../../../packages/core/src/admin/actor.js';
import { createProject } from '../../../packages/core/src/admin/projects.js';
import { parseTenantId } from '../../../packages/core/src/db/tenant-id.js';
import type { TenantScope } from '../../../packages/core/src/db/tenant-scope.js';
import { loadEffectiveConfig } from '../../../packages/core/src/registry/effective-config.js';
import { createTestDatabase, describeDb, tamper, type TestDatabase } from './helpers.js';

const OLD_HASH = '0'.repeat(63) + '1';
const YAML = 'budget:\n  warn_percent: 70\n';
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

describeDb('B13 AC8: stored configurations after a change of platform defaults', () => {
  let t0: TestDatabase;
  let scope: TenantScope;
  let count = 0;

  /** A project with a stored configuration (version 1). */
  async function stored(yaml = YAML): Promise<{ projectId: string; slug: string }> {
    const slug = `p${String(++count)}`;
    const project = await createProject(scope, SYSTEM_ACTOR, {
      slug,
      name: slug,
      repoFullName: `org/${slug}`,
    });
    await saveProjectConfig(scope, SYSTEM_ACTOR, slug, { configYaml: yaml, expectedVersion: 0 });
    return { projectId: project.id, slug };
  }

  const releaseChangedDefaults = (projectId: string) =>
    tamper(t0.name, `UPDATE project_configs SET config_hash = $1 WHERE project_id = $2`, [
      OLD_HASH,
      projectId,
    ]);

  const outcomeOf = async (projectId: string) =>
    (await reconcileStoredConfigs(t0.app)).find((result) => result.projectId === projectId);

  const refusal = (projectId: string) =>
    loadEffectiveConfig(scope.projectConfigs, projectId).then(
      () => 'loaded',
      (error: { code?: string }) => error.code,
    );

  beforeAll(async () => {
    t0 = await createTestDatabase();
    const result = await bootstrapTenant(t0.app, {
      tenantSlug: 'acme',
      tenantName: 'Acme',
      adminEmail: 'admin@acme.example.com',
      adminName: 'Admin',
    });
    scope = t0.app.forTenant(parseTenantId(result.tenant.id));
  }, 60_000);

  afterAll(async () => {
    await t0?.drop();
  });

  it('re-hashes an unchanged YAML, saves a new version, audits it as the system, and uses it', async () => {
    const { projectId } = await stored();
    const before = (await scope.projectConfigs.get(projectId))!;
    expect(before.override_sha256).toBe(sha256(YAML));
    await releaseChangedDefaults(projectId);
    expect(await refusal(projectId)).toBe('config_defaults_drift');

    expect(await outcomeOf(projectId)).toMatchObject({ outcome: 'rehashed', version: 2 });
    const after = (await scope.projectConfigs.get(projectId))!;
    expect(after).toMatchObject({
      version: 2,
      config_yaml: YAML,
      config_hash: before.config_hash,
      override_sha256: before.override_sha256,
      updated_by: null,
    });
    expect(await refusal(projectId)).toBe('loaded');
    const event = (
      await sql<{ actor_type: string; actor_id: string | null; payload: Record<string, unknown> }>`
        SELECT actor_type, actor_id, payload FROM audit_log
        WHERE tenant_id = ${scope.tenantId} AND entity_id = ${projectId} AND action = 'config.changed'
        ORDER BY seq DESC LIMIT 1`.execute(t0.owner)
    ).rows[0]!;
    expect(event).toEqual({
      actor_type: 'system',
      actor_id: null,
      payload: {
        version: 2,
        config_hash: before.config_hash,
        override_sha256: before.override_sha256,
        cause: 'defaults_changed',
      },
    });
    // Nothing more to do on the next start.
    expect(await outcomeOf(projectId)).toMatchObject({ outcome: 'unchanged' });
    expect((await scope.audit.verify()).broken).toBeUndefined();
  });

  it('E04: a configuration stored before `access.cost_read_roles` existed is re-hashed and loads', async () => {
    // A YAML that only repeats a default has the default configuration's hash. Before E04 that was
    // the pinned hash below (platform/tests/config/hash.test.ts); E04 added `cost_read_roles`.
    const PRE_E04_DEFAULT_HASH = '07c4252b04aecaad7d4fa8b5c09bc4b18d8f89f6174f4cf0b280350181edf788';
    const yaml = 'budget:\n  warn_percent: 80\n';
    const { projectId } = await stored(yaml);
    const current = (await scope.projectConfigs.get(projectId))!.config_hash;
    expect(current).not.toBe(PRE_E04_DEFAULT_HASH);
    await tamper(t0.name, `UPDATE project_configs SET config_hash = $1 WHERE project_id = $2`, [
      PRE_E04_DEFAULT_HASH,
      projectId,
    ]);
    expect(await refusal(projectId)).toBe('config_defaults_drift');
    expect(await outcomeOf(projectId)).toMatchObject({ outcome: 'rehashed', version: 2 });
    const { config, configHash } = await loadEffectiveConfig(scope.projectConfigs, projectId);
    expect(configHash).toBe(current);
    expect(config.access.cost_read_roles).toEqual([
      'person_a',
      'person_b',
      'pm_brse',
      'governance',
      'admin',
    ]);
  });

  it('E06: a configuration stored before `access.metrics_read_roles` existed is re-hashed and loads', async () => {
    // Before E06 the default configuration's hash was the one E04 pinned
    // (platform/tests/config/hash.test.ts); E06 added `metrics_read_roles`.
    const PRE_E06_DEFAULT_HASH = 'd9e7be28fc5dcee597088a2cac831571e764a083f6a744b5bd2dc4a9befbbdd2';
    const yaml = 'budget:\n  warn_percent: 80\n';
    const { projectId } = await stored(yaml);
    const current = (await scope.projectConfigs.get(projectId))!.config_hash;
    expect(current).not.toBe(PRE_E06_DEFAULT_HASH);
    await tamper(t0.name, `UPDATE project_configs SET config_hash = $1 WHERE project_id = $2`, [
      PRE_E06_DEFAULT_HASH,
      projectId,
    ]);
    expect(await refusal(projectId)).toBe('config_defaults_drift');
    expect(await outcomeOf(projectId)).toMatchObject({ outcome: 'rehashed', version: 2 });
    const { config, configHash } = await loadEffectiveConfig(scope.projectConfigs, projectId);
    expect(configHash).toBe(current);
    expect(config.access.metrics_read_roles).toEqual([
      'person_a',
      'person_b',
      'second_approver',
      'pm_brse',
      'governance',
      'admin',
    ]);
  });

  it('E02: a configuration stored before the `access.evidence_*_roles` keys existed is re-hashed and loads', async () => {
    // Before E02 the default configuration's hash was the one E06 pinned
    // (platform/tests/config/hash.test.ts); E02 added `evidence_build_roles` and `evidence_read_roles`.
    const PRE_E02_DEFAULT_HASH = '8389110fc9e9f326420f5b095cad79644199580afa19a185db41dffe8c052319';
    const yaml = 'budget:\n  warn_percent: 80\n';
    const { projectId } = await stored(yaml);
    const current = (await scope.projectConfigs.get(projectId))!.config_hash;
    expect(current).not.toBe(PRE_E02_DEFAULT_HASH);
    await tamper(t0.name, `UPDATE project_configs SET config_hash = $1 WHERE project_id = $2`, [
      PRE_E02_DEFAULT_HASH,
      projectId,
    ]);
    expect(await refusal(projectId)).toBe('config_defaults_drift');
    expect(await outcomeOf(projectId)).toMatchObject({ outcome: 'rehashed', version: 2 });
    const { config, configHash } = await loadEffectiveConfig(scope.projectConfigs, projectId);
    expect(configHash).toBe(current);
    expect(config.access.evidence_build_roles).toEqual([
      'person_a',
      'person_b',
      'pm_brse',
      'governance',
      'admin',
    ]);
    expect(config.access.evidence_read_roles).toEqual([
      'person_a',
      'person_b',
      'second_approver',
      'pm_brse',
      'governance',
      'admin',
    ]);
  });

  it('leaves a YAML changed outside the platform refused', async () => {
    const { projectId } = await stored();
    await tamper(t0.name, `UPDATE project_configs SET config_yaml = $1 WHERE project_id = $2`, [
      'budget:\n  warn_percent: 10\n',
      projectId,
    ]);
    expect(await outcomeOf(projectId)).toMatchObject({ outcome: 'override_changed' });
    expect((await scope.projectConfigs.get(projectId))!.version).toBe(1);
    expect(await refusal(projectId)).toBe('config_hash_mismatch');
  });

  it('leaves a YAML the new defaults make invalid refused (the project fails closed)', async () => {
    const { projectId } = await stored();
    // The same effect as a release that removed a setting the stored YAML still uses.
    const invalid = 'budget:\n  no_such_setting: 1\n';
    await tamper(
      t0.name,
      `UPDATE project_configs SET config_yaml = $1, override_sha256 = $2 WHERE project_id = $3`,
      [invalid, sha256(invalid), projectId],
    );
    expect(await outcomeOf(projectId)).toMatchObject({ outcome: 'config_invalid' });
    expect(await refusal(projectId)).toBe('config_invalid');
  });

  it('two processes at start re-hash once', async () => {
    const { projectId } = await stored();
    await releaseChangedDefaults(projectId);
    const [first, second] = await Promise.all([
      reconcileStoredConfigs(t0.app),
      reconcileStoredConfigs(t0.app),
    ]);
    const outcomes = [first, second].map(
      (results) => results.find((result) => result.projectId === projectId)!.outcome,
    );
    expect(outcomes.filter((outcome) => outcome === 'rehashed')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome !== 'rehashed')[0]).toMatch(/^(raced|unchanged)$/);
    expect((await scope.projectConfigs.get(projectId))!.version).toBe(2);
  });

  it('logs what changed or stays refused at start, with IDs and codes only', async () => {
    const { projectId } = await stored();
    await releaseChangedDefaults(projectId);
    const logged: { level: string; event: string; fields: Record<string, unknown> }[] = [];
    await checkStoredConfigsAtStart(t0.app, {
      log: (level, event, fields = {}) => logged.push({ level, event, fields }),
    });
    expect(logged).toContainEqual({
      level: 'info',
      event: 'config.rehashed',
      fields: { tenantId: scope.tenantId, projectId, version: 2 },
    });
    // Earlier tests left one changed YAML and one invalid YAML: both stay refused, as warnings.
    expect(
      logged
        .filter((line) => line.level === 'warn')
        .map((line) => line.event)
        .sort(),
    ).toEqual(['config.config_invalid', 'config.override_changed']);
    expect(JSON.stringify(logged)).not.toContain('warn_percent');
  });

  it('a project without a stored configuration is not touched', async () => {
    const project = await createProject(scope, SYSTEM_ACTOR, {
      slug: 'bare',
      name: 'Bare',
      repoFullName: 'org/bare',
    });
    expect(await outcomeOf(project.id)).toBeUndefined();
    expect(await scope.projectConfigs.get(project.id)).toBeUndefined();
  });
});
