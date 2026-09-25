// D-08 A07 AC1, AC2 and QUESTIONS #12 (static part): migration 0002 SQL, and the queries of the
// audit repository pass the tenant guard. Live behaviour: tests/integration/db/audit-log.test.ts.
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';

import { DbError, translatePgError } from '../../packages/core/src/db/errors.js';
import { MIGRATIONS } from '../../packages/core/src/db/migrations/index.js';
import { TenantGuardPlugin } from '../../packages/core/src/db/tenant-guard-plugin.js';
import { parseTenantId } from '../../packages/core/src/db/tenant-id.js';
import { dummyDb, TENANT_A } from './dummy.js';

const up = MIGRATIONS['0002-audit-log']!.statements.up.join(';\n');

describe('migration 0002: append-only audit_log', () => {
  it('blocks UPDATE, DELETE and TRUNCATE with triggers (D-05 7.2)', () => {
    expect(up).toMatch(
      /CREATE TRIGGER audit_log_no_update_delete BEFORE UPDATE OR DELETE ON audit_log\s+FOR EACH ROW EXECUTE FUNCTION forbid_mutation\(\)/,
    );
    expect(up).toMatch(
      /CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log\s+FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation\(\)/,
    );
  });

  it('grants platform_app only SELECT and INSERT on audit_log', () => {
    const grants = [...up.matchAll(/GRANT ([^;]*?) ON audit_log TO platform_app/g)].map(
      (m) => m[1],
    );
    expect(grants).toEqual(['SELECT, INSERT']);
    expect(up).toMatch(/REVOKE ALL ON audit_log FROM PUBLIC/);
  });

  it('keeps seq unique per tenant and checks each chain link on insert', () => {
    expect(up).toMatch(/UNIQUE \(tenant_id, seq\)/);
    expect(up).toMatch(/CREATE TRIGGER audit_log_check_link BEFORE INSERT ON audit_log/);
  });

  it('QUESTIONS #12: a revoked role binding can never change again', () => {
    expect(up).toMatch(
      /CREATE TRIGGER role_bindings_revocation_is_final BEFORE UPDATE ON role_bindings/,
    );
    expect(up).toMatch(/IF OLD\.revoked_at IS NOT NULL THEN/);
  });
});

describe('the audit repository queries pass the tenant guard', () => {
  const db = dummyDb().withPlugin(new TenantGuardPlugin(parseTenantId(TENANT_A)));

  it('accepts the advisory lock (a fragment without a table) and the tail read', () => {
    expect(() =>
      db
        .selectNoFrom(sql<null>`pg_advisory_xact_lock(1::int4, hashtext(${TENANT_A}))`.as('locked'))
        .compile(),
    ).not.toThrow();
    expect(() =>
      db
        .selectFrom('audit_log')
        .select(['seq', 'hash'])
        .where('tenant_id', '=', TENANT_A)
        .orderBy('seq', 'desc')
        .limit(1)
        .compile(),
    ).not.toThrow();
  });

  it('rejects a read of audit_log without the tenant condition', () => {
    expect(() => db.selectFrom('audit_log').selectAll().compile()).toThrow(/tenant/);
  });
});

describe('trigger errors map to stable DbError codes', () => {
  it.each([
    ['SDA01', 'immutable'],
    ['SDA02', 'conflict'],
    ['SDA03', 'immutable'],
  ])('%s -> %s', (sqlState, code) => {
    expect(() => translatePgError({ code: sqlState })).toThrow(
      expect.objectContaining({ name: 'DbError', code }) as DbError,
    );
  });
});
