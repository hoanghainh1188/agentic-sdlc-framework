// D-08 A06 AC3: the tenant guard rejects any query that is not limited to the scope's tenant.
import { sql, type Compilable, type Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';

import { TenantGuardError } from '../../packages/core/src/db/errors.js';
import type { Database } from '../../packages/core/src/db/schema.js';
import { TenantGuardPlugin } from '../../packages/core/src/db/tenant-guard-plugin.js';
import { parseTenantId } from '../../packages/core/src/db/tenant-id.js';
import { dummyDb, SOME_ID, TENANT_A, TENANT_B } from './dummy.js';

const db: Kysely<Database> = dummyDb().withPlugin(new TenantGuardPlugin(parseTenantId(TENANT_A)));

/** Builds and compiles the query. Subqueries built from `db` are checked while building. */
function guardCode(build: () => Compilable): string | undefined {
  try {
    build().compile();
    return undefined;
  } catch (error) {
    if (error instanceof TenantGuardError) return error.code;
    throw error;
  }
}

describe('accepted queries', () => {
  it('select, update and insert limited to the tenant', () => {
    expect(
      guardCode(() => db.selectFrom('users').selectAll().where('tenant_id', '=', TENANT_A)),
    ).toBeUndefined();
    expect(
      guardCode(() =>
        db
          .updateTable('users')
          .set({ status: 'disabled' })
          .where('tenant_id', '=', TENANT_A)
          .where('id', '=', SOME_ID),
      ),
    ).toBeUndefined();
    expect(
      guardCode(() =>
        db
          .insertInto('users')
          .values({ tenant_id: TENANT_A, display_name: 'A', email: 'a@example.com' }),
      ),
    ).toBeUndefined();
  });

  it('a JOIN where every table has its own tenant condition (in WHERE or in its ON clause)', () => {
    const query = db
      .selectFrom('role_bindings as rb')
      .innerJoin('users as u', (join) =>
        join.onRef('u.id', '=', 'rb.user_id').on('u.tenant_id', '=', TENANT_A),
      )
      .select(['rb.role', 'u.email'])
      .where('rb.tenant_id', '=', TENANT_A);
    expect(guardCode(() => query)).toBeUndefined();
  });

  it('a subquery and a CTE, each with its own tenant condition', () => {
    const subquery = db
      .selectFrom('users')
      .selectAll()
      .where('users.tenant_id', '=', TENANT_A)
      .where(
        'id',
        'in',
        db.selectFrom('role_bindings').select('user_id').where('tenant_id', '=', TENANT_A),
      );
    expect(guardCode(() => subquery)).toBeUndefined();

    const cte = db
      .with('active_users', (qb) =>
        qb.selectFrom('users').select('id').where('tenant_id', '=', TENANT_A),
      )
      .selectFrom('active_users')
      .selectAll();
    expect(guardCode(() => cte)).toBeUndefined();
  });

  it('the tenants table, limited by its id', () => {
    expect(
      guardCode(() => db.selectFrom('tenants').selectAll().where('id', '=', TENANT_A)),
    ).toBeUndefined();
  });
});

describe('rejected: missing or wrong tenant condition', () => {
  it('no WHERE at all', () => {
    expect(guardCode(() => db.selectFrom('users').selectAll())).toBe('missing_tenant_filter');
  });

  it('another tenant', () => {
    expect(
      guardCode(() => db.selectFrom('users').selectAll().where('tenant_id', '=', TENANT_B)),
    ).toBe('missing_tenant_filter');
  });

  it('the condition sits under OR', () => {
    const query = db
      .selectFrom('users')
      .selectAll()
      .where((eb) => eb.or([eb('tenant_id', '=', TENANT_A), eb('email', '=', 'x@example.com')]));
    expect(guardCode(() => query)).toBe('missing_tenant_filter');
  });

  it('the condition is not an equality', () => {
    expect(
      guardCode(() => db.selectFrom('users').selectAll().where('tenant_id', '!=', TENANT_B)),
    ).toBe('missing_tenant_filter');
    expect(
      guardCode(() =>
        db.selectFrom('users').selectAll().where('tenant_id', 'in', [TENANT_A, TENANT_B]),
      ),
    ).toBe('missing_tenant_filter');
  });

  it('UPDATE without a tenant condition', () => {
    expect(
      guardCode(() =>
        db.updateTable('users').set({ status: 'disabled' }).where('id', '=', SOME_ID),
      ),
    ).toBe('missing_tenant_filter');
  });

  it('DELETE without a tenant condition', () => {
    expect(guardCode(() => db.deleteFrom('users').where('id', '=', SOME_ID))).toBe(
      'missing_tenant_filter',
    );
  });
});

describe('rejected: JOIN, subquery and CTE missing the tenant condition on the inner table', () => {
  it('JOIN: the joined table has no tenant condition', () => {
    const query = db
      .selectFrom('role_bindings as rb')
      .innerJoin('users as u', 'u.id', 'rb.user_id')
      .select(['rb.role', 'u.email'])
      .where('rb.tenant_id', '=', TENANT_A);
    expect(guardCode(() => query)).toBe('missing_tenant_filter');
  });

  it('JOIN: the condition on the outer table in the ON clause does not scope the joined table', () => {
    const query = db
      .selectFrom('role_bindings as rb')
      .leftJoin('users as u', (join) =>
        join.onRef('u.id', '=', 'rb.user_id').on('rb.tenant_id', '=', TENANT_A),
      )
      .select(['rb.role', 'u.email'])
      .where('rb.tenant_id', '=', TENANT_A);
    expect(guardCode(() => query)).toBe('missing_tenant_filter');
  });

  it('JOIN: an unqualified tenant_id is ambiguous and does not count', () => {
    const query = db
      .selectFrom('role_bindings')
      .innerJoin('users', 'users.id', 'role_bindings.user_id')
      .selectAll()
      .where('tenant_id', '=', TENANT_A);
    expect(guardCode(() => query)).toBe('missing_tenant_filter');
  });

  it('subquery in WHERE: the inner table has no tenant condition', () => {
    const query = db
      .selectFrom('users')
      .selectAll()
      .where('tenant_id', '=', TENANT_A)
      .where('id', 'in', (eb) =>
        eb.selectFrom('role_bindings').select('user_id').where('role', '=', 'person_b'),
      );
    expect(guardCode(() => query)).toBe('missing_tenant_filter');
    // Built from the guarded instance, the subquery is rejected while the query is built.
    expect(
      guardCode(() =>
        db
          .selectFrom('users')
          .selectAll()
          .where('tenant_id', '=', TENANT_A)
          .where('id', 'in', db.selectFrom('role_bindings').select('user_id')),
      ),
    ).toBe('missing_tenant_filter');
  });

  it('subquery in the select list and derived table in FROM', () => {
    const inSelect = db
      .selectFrom('projects')
      .select((eb) => [
        'id',
        eb
          .selectFrom('role_bindings')
          .select(eb.fn.countAll().as('n'))
          .whereRef('project_id', '=', 'projects.id')
          .as('bindings'),
      ])
      .where('tenant_id', '=', TENANT_A);
    expect(guardCode(() => inSelect)).toBe('missing_tenant_filter');

    const derived = db.selectFrom((eb) => eb.selectFrom('users').select('id').as('x')).selectAll();
    expect(guardCode(() => derived)).toBe('missing_tenant_filter');
  });

  it('CTE (WITH): the inner query has no tenant condition', () => {
    const query = db
      .with('all_users', (qb) => qb.selectFrom('users').select(['id', 'email']))
      .selectFrom('all_users')
      .selectAll();
    expect(guardCode(() => query)).toBe('missing_tenant_filter');
  });

  it('CTE: the outer query joins a real table without a tenant condition', () => {
    const query = db
      .with('mine', (qb) => qb.selectFrom('users').select('id').where('tenant_id', '=', TENANT_A))
      .selectFrom('mine')
      .innerJoin('api_tokens as t', 't.user_id', 'mine.id')
      .selectAll();
    expect(guardCode(() => query)).toBe('missing_tenant_filter');
  });

  it('CTE named like a platform table', () => {
    const query = db
      .with('users', (qb) =>
        qb.selectFrom('projects').select('id').where('tenant_id', '=', TENANT_A),
      )
      .selectFrom('users')
      .selectAll();
    expect(guardCode(() => query)).toBe('cte_shadows_table');
  });
});

describe('rejected: writes that could cross tenants', () => {
  it('INSERT without the tenant column, or with another tenant in any row', () => {
    const noTenant = db
      .insertInto('users')
      .values({ display_name: 'A', email: 'a@example.com' } as never);
    expect(guardCode(() => noTenant)).toBe('insert_without_tenant');

    const otherTenant = db.insertInto('users').values([
      { tenant_id: TENANT_A, display_name: 'A', email: 'a@example.com' },
      { tenant_id: TENANT_B, display_name: 'B', email: 'b@example.com' },
    ]);
    expect(guardCode(() => otherTenant)).toBe('insert_without_tenant');
  });

  it('INSERT … SELECT', () => {
    const query = db
      .insertInto('users')
      .columns(['tenant_id', 'display_name', 'email'])
      .expression(
        db
          .selectFrom('users')
          .select(['tenant_id', 'display_name', 'email'])
          .where('tenant_id', '=', TENANT_A),
      );
    expect(guardCode(() => query)).toBe('insert_without_tenant');
  });

  it('INSERT into tenants (system scope only)', () => {
    expect(guardCode(() => db.insertInto('tenants').values({ slug: 'x', name: 'X' }))).toBe(
      'unsupported_statement',
    );
  });

  it('UPDATE of the own tenant row (budget and status are platform-admin decisions)', () => {
    expect(
      guardCode(() =>
        db.updateTable('tenants').set({ status: 'suspended' }).where('id', '=', TENANT_A),
      ),
    ).toBe('unsupported_statement');
  });

  it('UPDATE that changes tenant_id', () => {
    const query = db
      .updateTable('users')
      .set({ tenant_id: TENANT_B } as never)
      .where('tenant_id', '=', TENANT_A);
    expect(guardCode(() => query)).toBe('tenant_column_write');
  });

  it('ON CONFLICT DO UPDATE (its target row may belong to another tenant)', () => {
    const query = db
      .insertInto('git_event_cursors')
      .values({ tenant_id: TENANT_A, project_id: SOME_ID, cursor: 'c', last_polled_at: new Date() })
      .onConflict((oc) => oc.column('project_id').doUpdateSet({ cursor: 'c' }));
    expect(guardCode(() => query)).toBe('tenant_column_write');
  });
});

describe('rejected: statements outside the model', () => {
  it('raw SQL statements', async () => {
    await expect(sql`select * from users`.execute(db)).rejects.toMatchObject({ code: 'raw_sql' });
  });

  it('tables unknown to the tenant model (migration tables, other schemas)', () => {
    expect(
      guardCode(
        () => db.selectFrom('kysely_migration' as never).selectAll() as unknown as Compilable,
      ),
    ).toBe('unknown_table');
    expect(
      guardCode(
        () => db.selectFrom('pg_catalog.pg_roles' as never).selectAll() as unknown as Compilable,
      ),
    ).toBe('unknown_table');
  });
});
