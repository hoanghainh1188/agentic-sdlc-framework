// D-08 A06 AC2 on a live PostgreSQL: tables, columns, enums, composite foreign keys (D-05 D2),
// unique constraints and the privileges of the application role.
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  migrateDown,
  migrateToLatest,
  migrationStatus,
} from '../../../packages/core/src/db/migrator.js';
import { MIGRATIONS } from '../../../packages/core/src/db/migrations/index.js';
import { TABLE_COLUMNS } from '../../../packages/core/src/db/schema.js';
import { DB_ENUMS } from '../../../packages/core/src/db/vocabulary.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

const TABLES = Object.keys(TABLE_COLUMNS).sort();
// Columns platform_app may UPDATE (ADR-M09 section 2.3). Everything else, including every id,
// tenant_id and created_at, is fixed once inserted.
const UPDATABLE: Record<string, readonly string[]> = {
  tenants: ['name', 'monthly_budget_usd', 'status'],
  projects: ['name', 'repo_full_name', 'default_branch', 'status'],
  project_configs: ['version', 'config_yaml', 'config_hash', 'updated_by'],
  project_ai_records: [
    'version',
    'ai_allowed',
    'allowed_data_classes',
    'allowed_tools_locations',
    'prod_logs_allowed',
    'disclosure_format',
    'confirmed_by',
    'confirmed_at',
    'updated_by',
  ],
  users: ['display_name', 'email', 'status'],
  user_identities: ['external_login'],
  role_bindings: ['revoked_at'],
  api_tokens: ['last_used_at', 'revoked_at'],
  git_event_cursors: ['cursor', 'last_polled_at'],
};

describeDb('AC2: migrations on PostgreSQL', () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  });

  const rows = async <T>(query: ReturnType<typeof sql<T>>) => (await query.execute(t.owner)).rows;

  it('applies every migration and records it', async () => {
    const status = await migrationStatus(t.owner);
    expect(status.map((m) => m.name)).toEqual(Object.keys(MIGRATIONS));
    expect(status.every((m) => m.executedAt instanceof Date)).toBe(true);
  });

  it('creates exactly the tables of the schema model, with the same columns in order (no drift)', async () => {
    const tables = await rows<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name NOT LIKE 'kysely_%' ORDER BY table_name`);
    expect(tables.map((r) => r.table_name)).toEqual(TABLES);
    for (const [table, columns] of Object.entries(TABLE_COLUMNS)) {
      const actual = await rows<{ column_name: string }>(sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ${table} ORDER BY ordinal_position`);
      expect(
        actual.map((r) => r.column_name),
        table,
      ).toEqual([...columns]);
    }
  });

  it('gives every table except tenants tenant_id uuid NOT NULL, and every table created_at', async () => {
    const cols = await rows<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(sql`
      SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name IN ('tenant_id', 'created_at')`);
    for (const table of TABLES) {
      const createdAt = cols.find((c) => c.table_name === table && c.column_name === 'created_at');
      expect(createdAt, table).toMatchObject({
        data_type: 'timestamp with time zone',
        is_nullable: 'NO',
        column_default: 'now()',
      });
      const tenantId = cols.find((c) => c.table_name === table && c.column_name === 'tenant_id');
      if (table === 'tenants') expect(tenantId).toBeUndefined();
      else expect(tenantId, table).toMatchObject({ data_type: 'uuid', is_nullable: 'NO' });
    }
  });

  it('creates only the enums used now, with the canonical values', async () => {
    const enums = await rows<{ name: string; values: string[] }>(sql`
      SELECT t.typname AS name, array_agg(e.enumlabel ORDER BY e.enumsortorder)::text[] AS values
      FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
      JOIN pg_namespace n ON n.oid = t.typnamespace AND n.nspname = 'public'
      GROUP BY t.typname ORDER BY t.typname`);
    expect(Object.fromEntries(enums.map((e) => [e.name, e.values]))).toEqual(
      Object.fromEntries(Object.entries(DB_ENUMS).map(([k, v]) => [k, [...v]])),
    );
  });

  it('D-05 D2: every foreign key between tenant tables includes tenant_id on both sides', async () => {
    const fks = await rows<{
      name: string;
      child: string;
      parent: string;
      child_cols: string[];
      parent_cols: string[];
      on_delete: string;
    }>(sql`
      SELECT c.conname AS name, c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent,
        (SELECT array_agg(a.attname ORDER BY k.ord)::text[] FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS child_cols,
        (SELECT array_agg(a.attname ORDER BY k.ord)::text[] FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) AS parent_cols,
        c.confdeltype AS on_delete
      FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace AND n.nspname = 'public'
      WHERE c.contype = 'f' AND c.conrelid::regclass::text NOT LIKE 'kysely_%'`);
    expect(fks).toHaveLength(11);
    for (const fk of fks) {
      expect(fk.on_delete, fk.name).toBe('r'); // RESTRICT: no hard deletes (D-05 D7)
      if (fk.parent === 'tenants') {
        expect([fk.child_cols, fk.parent_cols], fk.name).toEqual([['tenant_id'], ['id']]);
      } else {
        expect(fk.child_cols[0], fk.name).toBe('tenant_id');
        expect(fk.parent_cols, fk.name).toEqual(['tenant_id', 'id']);
      }
    }
    // Every tenant table that has no composite parent references tenants directly.
    for (const table of ['projects', 'users']) {
      expect(
        fks.some((fk) => fk.child === table && fk.parent === 'tenants'),
        table,
      ).toBe(true);
    }
  });

  it('has the unique constraints of D-05 section 9 and the approved additions', async () => {
    const indexes = await rows<{ indexname: string; indexdef: string }>(sql`
      SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexdef LIKE 'CREATE UNIQUE%'`);
    const defs = indexes.map((i) =>
      i.indexdef.replace(/^.* USING btree /, `${i.indexdef.split(' ON ')[1]!.split(' ')[0]} `),
    );
    for (const expected of [
      'public.tenants (slug)',
      'public.projects (tenant_id, slug)',
      'public.users (tenant_id, lower(email))',
      'public.user_identities (tenant_id, provider, external_id)',
      'public.role_bindings (tenant_id, user_id, project_id, role) WHERE (revoked_at IS NULL)',
      'public.api_tokens (token_hash)',
    ]) {
      expect(defs, expected).toContain(expected);
    }
  });

  it('api_tokens has no column for the raw token and only accepts a SHA-256 hex hash', async () => {
    expect(TABLE_COLUMNS.api_tokens).not.toContain('token');
    const checks = await rows<{ def: string }>(sql`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'api_tokens'::regclass AND contype = 'c'`);
    expect(checks.map((c) => c.def).join('\n')).toMatch(/token_hash.*\[0-9a-f\]\{64\}/);
  });

  it('platform_app: SELECT and INSERT; UPDATE only on mutable columns; never DELETE, TRUNCATE or DDL', async () => {
    for (const table of TABLES) {
      const [p] = await rows<Record<string, boolean>>(sql`
        SELECT has_table_privilege('platform_app', ${`public.${table}`}, 'SELECT') AS select,
               has_table_privilege('platform_app', ${`public.${table}`}, 'INSERT') AS insert,
               has_table_privilege('platform_app', ${`public.${table}`}, 'UPDATE') AS update,
               has_table_privilege('platform_app', ${`public.${table}`}, 'DELETE') AS delete,
               has_table_privilege('platform_app', ${`public.${table}`}, 'TRUNCATE') AS truncate,
               has_table_privilege('platform_app', ${`public.${table}`}, 'TRIGGER') AS trigger,
               has_table_privilege('platform_app', ${`public.${table}`}, 'REFERENCES') AS references`);
      expect(p, table).toEqual({
        select: true,
        insert: true,
        update: false,
        delete: false,
        truncate: false,
        trigger: false,
        references: false,
      });
      const updatable = await rows<{ column_name: string }>(sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ${table}
          AND has_column_privilege('platform_app', ${`public.${table}`}, column_name, 'UPDATE')
        ORDER BY ordinal_position`);
      expect(
        updatable.map((c) => c.column_name),
        table,
      ).toEqual(UPDATABLE[table]);
    }
    await expect(sql`DELETE FROM users`.execute(t.appRaw)).rejects.toMatchObject({ code: '42501' });
    await expect(sql`TRUNCATE users`.execute(t.appRaw)).rejects.toMatchObject({ code: '42501' });
    await expect(sql`CREATE TABLE x (id int)`.execute(t.appRaw)).rejects.toMatchObject({
      code: '42501',
    });
    await expect(sql`SELECT * FROM kysely_migration`.execute(t.appRaw)).rejects.toMatchObject({
      code: '42501',
    });
    await expect(
      sql`UPDATE users SET tenant_id = gen_random_uuid()`.execute(t.appRaw),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('migrating again does nothing; down and up again work (development only)', async () => {
    const again = await migrateToLatest(t.owner);
    expect(again.error).toBeUndefined();
    expect(again.results).toEqual([]);
    const down = await migrateDown(t.owner);
    expect(down.error).toBeUndefined();
    const tables = await rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name NOT LIKE 'kysely_%'`);
    expect(tables[0]!.n).toBe(0);
    const up = await migrateToLatest(t.owner);
    expect(up.error).toBeUndefined();
    expect(up.results?.map((r) => r.status)).toEqual(['Success']);
  });
});
