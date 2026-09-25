// D-08 A06 AC1, AC2 (static part): schema model, migration list and migration SQL.
import fs from 'node:fs';
import path from 'node:path';

import { ACTOR_TYPES, DATA_CLASSES, PROJECT_ROLES } from '@sdlc/contracts';
import { t } from '@sdlc/messages';
import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from '../../packages/core/src/db/migrations/index.js';
import { TABLE_COLUMNS, TENANT_COLUMN } from '../../packages/core/src/db/schema.js';
import { DB_ENUMS } from '../../packages/core/src/db/vocabulary.js';

const repoRoot = path.resolve(__dirname, '../../..');
const upSql = Object.values(MIGRATIONS)
  .flatMap((m) => m.statements.up)
  .join(';\n');

describe('AC1: migration tool', () => {
  it('uses Kysely + pg only as third-party packages (ADR-M09)', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'platform/packages/core/package.json'), 'utf8'),
    ) as { dependencies: Record<string, string> };
    const deps = Object.entries(pkg.dependencies);
    const external = deps.filter(([name]) => !name.startsWith('@sdlc/'));
    expect(external.map(([name]) => name).sort()).toEqual(['kysely', 'pg']);
    for (const [, version] of external) expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    for (const [name, version] of deps.filter(([n]) => n.startsWith('@sdlc/')))
      expect(version, name).toBe('workspace:*');
  });

  it('records the decision in ADR-M09', () => {
    const adr = fs.readFileSync(path.join(repoRoot, 'design/ADR-M09-database-tooling.md'), 'utf8');
    expect(adr).toMatch(/Kysely/);
    expect(adr).toMatch(/ALTER TYPE .* ADD VALUE/);
  });

  it('lists migrations in order, as plain SQL', () => {
    const names = Object.keys(MIGRATIONS);
    expect(names).toEqual([...names].sort());
    for (const name of names) {
      expect(name).toMatch(/^\d{4}-[a-z0-9-]+$/);
      expect(MIGRATIONS[name]!.statements.up.length).toBeGreaterThan(0);
    }
  });
});

describe('AC2: tenancy tables (static checks of the migration SQL)', () => {
  it('creates exactly the tables of the schema model', () => {
    const created = [...upSql.matchAll(/CREATE TABLE (\w+)/g)].map((m) => m[1]).sort();
    expect(created).toEqual(Object.keys(TABLE_COLUMNS).sort());
  });

  it('knows the tenant column of every table; every table except tenants has tenant_id', () => {
    expect(Object.keys(TENANT_COLUMN).sort()).toEqual(Object.keys(TABLE_COLUMNS).sort());
    for (const [table, columns] of Object.entries(TABLE_COLUMNS)) {
      expect(columns, table).toContain('created_at');
      if (table !== 'tenants') expect(columns, table).toContain('tenant_id');
    }
  });

  it('creates the enums with the canonical values (D-05 section 5)', () => {
    for (const [name, values] of Object.entries(DB_ENUMS)) {
      const match = new RegExp(`CREATE TYPE ${name} AS ENUM\\s*\\(([^)]*)\\)`).exec(upSql);
      expect(match, name).not.toBeNull();
      const created = [...match![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]);
      expect(created, name).toEqual([...values]);
    }
  });

  it('never grants DELETE, TRUNCATE or table-wide UPDATE to platform_app', () => {
    const grants = [...upSql.matchAll(/GRANT ([^;]*?) TO platform_app/g)].map((m) => m[1]!);
    expect(grants.length).toBeGreaterThan(0);
    for (const grant of grants) {
      expect(grant).not.toMatch(/DELETE|TRUNCATE|ALL/);
      expect(grant).not.toMatch(/UPDATE\s+ON/);
      expect(grant).not.toMatch(/\b(tenant_id|created_at)\b/);
    }
  });
});

describe('canonical codes come from @sdlc/contracts (no second copy in core)', () => {
  it('uses the contracts lists for the data_class, project_role and actor_type enums', () => {
    expect(DB_ENUMS.data_class).toBe(DATA_CLASSES);
    expect(DB_ENUMS.project_role).toBe(PROJECT_ROLES);
    expect(DB_ENUMS.actor_type).toBe(ACTOR_TYPES);
  });
});

describe('database command messages (@sdlc/messages)', () => {
  // The exact text the migrate command printed before the messages moved to the shared catalog.
  it('renders the same text as before', () => {
    expect(t('db.migrate.usage')).toBe(
      'Usage: migrate-cli <latest|status>. Needs SDLC_DB_MIGRATION_URL (owner role).',
    );
    expect(t('db.migrate.missing_url')).toBe('SDLC_DB_MIGRATION_URL is not set.');
    expect(t('db.migrate.applied', { name: '0001-tenancy' })).toBe(
      'Applied migration 0001-tenancy.',
    );
    expect(t('db.migrate.failed_migration', { name: '0001-tenancy' })).toBe(
      'Migration 0001-tenancy failed; it was rolled back.',
    );
    expect(t('db.migrate.up_to_date')).toBe('The database is up to date.');
    expect(t('db.migrate.failed', { reason: 'boom' })).toBe('Migration failed: boom');
    expect(
      t('db.status.applied', { name: '0001-tenancy', executed_at: '2026-09-25T00:00:00.000Z' }),
    ).toBe('applied  0001-tenancy  2026-09-25T00:00:00.000Z');
    expect(t('db.status.pending', { name: '0001-tenancy' })).toBe('pending  0001-tenancy');
  });

  it('keeps a missing parameter visible', () => {
    expect(t('db.migrate.failed')).toBe('Migration failed: {reason}');
  });
});
