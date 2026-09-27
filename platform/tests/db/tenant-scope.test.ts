// D-08 A06 AC3: the data access layer requires a tenant, at the type level and at runtime.
import { NoResultError, type Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';

import { DbError, TenantGuardError } from '../../packages/core/src/db/errors.js';
import type { PlatformDatabase } from '../../packages/core/src/db/platform-database.js';
import type { Database } from '../../packages/core/src/db/schema.js';
import { hashApiToken } from '../../packages/core/src/db/repositories/api-tokens.js';
import { TenantScope } from '../../packages/core/src/db/tenant-scope.js';
import { isUuid, parseTenantId, type TenantId } from '../../packages/core/src/db/tenant-id.js';
import { dummyDb, SOME_ID, TENANT_A, TENANT_B } from './dummy.js';

describe('parseTenantId', () => {
  it('accepts a UUID and normalises it to lower case', () => {
    expect(parseTenantId(TENANT_A)).toBe(TENANT_A);
    expect(parseTenantId(TENANT_A.toUpperCase())).toBe(TENANT_A);
    expect(isUuid(TENANT_A)).toBe(true);
  });

  it.each([undefined, null, '', 'tenant-a', `${TENANT_A} `, `${TENANT_A}' OR 1=1`, 42])(
    'rejects %j',
    (value) => {
      expect(() => parseTenantId(value)).toThrow(DbError);
      expect(() => parseTenantId(value)).toThrow(
        expect.objectContaining({ code: 'invalid_tenant_id' }),
      );
    },
  );
});

describe('TenantScope', () => {
  it('re-checks the tenant ID at runtime (a forged TenantId is rejected)', () => {
    expect(() => new TenantScope(dummyDb(), 'not-a-uuid' as TenantId)).toThrow(
      expect.objectContaining({ code: 'invalid_tenant_id' }),
    );
  });

  it('every repository method passes the tenant guard', async () => {
    const scope = new TenantScope(dummyDb(), parseTenantId(TENANT_A));
    const calls: (() => Promise<unknown>)[] = [
      () =>
        scope.projects.create({
          slug: 's',
          name: 'S',
          git_provider: 'github',
          repo_full_name: 'o/r',
        }),
      () => scope.projects.getById(SOME_ID),
      () => scope.projects.getBySlug('s'),
      () => scope.projects.list(),
      () => scope.users.create({ display_name: 'U', email: 'u@example.com' }),
      () => scope.users.getById(SOME_ID),
      () => scope.users.getByEmail('U@example.com'),
      () => scope.users.list(),
      () => scope.users.setStatus(SOME_ID, 'disabled'),
      () =>
        scope.userIdentities.link({
          user_id: SOME_ID,
          provider: 'github',
          external_id: '1',
          external_login: 'u',
        }),
      () => scope.userIdentities.findByExternalId('github', '1'),
      () => scope.userIdentities.listForUser(SOME_ID),
      () => scope.roleBindings.grant({ user_id: SOME_ID, project_id: SOME_ID, role: 'person_a' }),
      () => scope.roleBindings.listForProject(SOME_ID),
      () => scope.roleBindings.listForUser(SOME_ID),
      () => scope.roleBindings.listForProject(SOME_ID, { includeRevoked: true }),
      () => scope.roleBindings.getById(SOME_ID),
      () => scope.roleBindings.revoke(SOME_ID),
      () =>
        scope.apiTokens.create({
          user_id: SOME_ID,
          name: 'laptop',
          token_hash: hashApiToken('secret'),
          expires_at: new Date(Date.now() + 86_400_000),
        }),
      () => scope.apiTokens.getById(SOME_ID),
      () => scope.apiTokens.listForUser(SOME_ID),
      () => scope.apiTokens.revoke(SOME_ID),
      () => scope.apiTokens.touchLastUsed(SOME_ID),
      () => scope.gitEventCursors.get(SOME_ID),
      () => scope.gitEventCursors.save(SOME_ID, 'cursor-1'),
      () => scope.projectConfigs.get(SOME_ID),
      () =>
        scope.projectConfigs.save(SOME_ID, {
          configYaml: 'a: 1',
          configHash: 'a'.repeat(64),
          updatedBy: null,
          expectedVersion: 0,
        }),
      () =>
        scope.projectConfigs.save(SOME_ID, {
          configYaml: 'a: 1',
          configHash: 'a'.repeat(64),
          updatedBy: null,
          expectedVersion: 1,
        }),
      () => scope.projectAiRecords.get(SOME_ID),
      ...[0, 1].map(
        (expectedVersion) => () =>
          scope.projectAiRecords.save(SOME_ID, {
            aiAllowed: 'yes',
            allowedDataClasses: ['internal'],
            prodLogsAllowed: 'no',
            disclosureFormat: 'standard_note',
            recordRef: null,
            actorType: 'human',
            confirmedAt: null,
            updatedBy: SOME_ID,
            expectedVersion,
          }),
      ),
    ];
    for (const call of calls) {
      // The dummy driver returns no rows: "not found" outcomes are expected, guard errors are not.
      await call().catch((error: unknown) => {
        if (error instanceof NoResultError) return;
        if (error instanceof DbError && error.code === 'version_conflict') return;
        expect(error).not.toBeInstanceOf(TenantGuardError);
        throw error;
      });
    }
  });

  it('a transaction keeps the same tenant and the guard', async () => {
    const scope = new TenantScope(dummyDb(), parseTenantId(TENANT_A));
    const inTransaction = await scope.transaction((trx) => {
      // The query builder is private; reach it only to prove the guard is attached.
      const trxDb = (trx as unknown as { db: Kysely<Database> }).db;
      const unscoped = () => trxDb.selectFrom('users').selectAll().compile();
      return Promise.resolve({ tenantId: trx.tenantId, unscoped });
    });
    expect(inTransaction.tenantId).toBe(TENANT_A);
    expect(inTransaction.unscoped).toThrow(TenantGuardError);
  });

  it('rejects a raw token instead of a SHA-256 hash', async () => {
    const scope = new TenantScope(dummyDb(), parseTenantId(TENANT_A));
    await expect(
      scope.apiTokens.create({
        user_id: SOME_ID,
        name: 'x',
        token_hash: 'sdlc_rawtoken',
        expires_at: new Date(),
      }),
    ).rejects.toMatchObject({ code: 'invalid_value' });
    expect(hashApiToken('abc')).toMatch(/^[0-9a-f]{64}$/);
  });
});

// Compile-time checks (pnpm typecheck). Never called.
export function typeChecks(db: PlatformDatabase, scope: TenantScope): void {
  // @ts-expect-error a plain string is not a TenantId: it must go through parseTenantId
  db.forTenant(TENANT_B);
  void scope.users.create({
    display_name: 'U',
    email: 'u@example.com',
    // @ts-expect-error the scope sets tenant_id; callers cannot pass one
    tenant_id: TENANT_B,
  });
  // @ts-expect-error the raw query builder is not exposed
  void db.db;
}
