// D-08 C03 (static part): migration 0005 SQL (cost_records), append-only, codes and numbers only,
// and the cost queries pass the tenant guard. Live behaviour: tests/integration/db/cost.test.ts.
import { PROVIDER_TYPES } from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from '../../packages/core/src/db/migrations/index.js';
import { TABLE_COLUMNS, TENANT_COLUMN } from '../../packages/core/src/db/schema.js';
import { TenantGuardPlugin } from '../../packages/core/src/db/tenant-guard-plugin.js';
import { parseTenantId } from '../../packages/core/src/db/tenant-id.js';
import { dummyDb, TENANT_A } from './dummy.js';

const up = MIGRATIONS['0005-cost-records']!.statements.up.join(';\n');

describe('migration 0005: cost_records', () => {
  it('is the last migration', () => {
    expect(Object.keys(MIGRATIONS).at(-1)).toBe('0005-cost-records');
  });

  it('is append-only: UPDATE/DELETE and TRUNCATE triggers, SELECT and INSERT grants only', () => {
    expect(up).toMatch(
      /CREATE TRIGGER cost_records_no_update_delete BEFORE UPDATE OR DELETE ON cost_records\s+FOR EACH ROW EXECUTE FUNCTION forbid_mutation\(\)/,
    );
    expect(up).toMatch(
      /CREATE TRIGGER cost_records_no_truncate BEFORE TRUNCATE ON cost_records\s+FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation\(\)/,
    );
    const grants = [...up.matchAll(/GRANT ([^;]*?) ON ([^;]*?) TO platform_app/g)].map((m) => [
      m[1],
      m[2],
    ]);
    expect(grants).toEqual([['SELECT, INSERT', 'cost_records']]);
    expect(up).toContain('REVOKE ALL ON cost_records FROM PUBLIC');
  });

  it('holds no free-text column: every text column has a format CHECK', () => {
    const table = MIGRATIONS['0005-cost-records']!.statements.up[0]!;
    expect(table).toMatch(/^CREATE TABLE cost_records/);
    const textColumns = table
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^[a-z_]+\s+text\b/.test(line));
    expect(textColumns.map((l) => l.split(/\s+/)[0])).toEqual([
      'agent',
      'model',
      'provider_type',
      'source_ref',
    ]);
    for (const line of textColumns) expect(line).toMatch(/CHECK \(/);
  });

  it('provider_type lists the same values as @sdlc/contracts', () => {
    const values = /provider_type IN \(([^)]*)\)/.exec(up)![1]!;
    expect([...values.matchAll(/'([^']+)'/g)].map((m) => m[1])).toEqual([...PROVIDER_TYPES]);
  });

  it('money is numeric(18,6), tokens bigint, all at least 0 (D-05 D6)', () => {
    expect(up).toMatch(/cost_usd\s+numeric\(18,6\) NOT NULL CHECK \(cost_usd >= 0\)/);
    for (const col of ['input_tokens', 'output_tokens', 'cached_input_tokens']) {
      expect(up).toMatch(new RegExp(`${col}\\s+bigint NOT NULL.*CHECK \\(${col} >= 0\\)`));
    }
  });

  it('one row per gateway call and tenant; foreign keys include the tenant (D-05 D2)', () => {
    expect(up).toContain(
      'CONSTRAINT cost_records_tenant_id_source_ref_key UNIQUE (tenant_id, source_ref)',
    );
    for (const [col, parent] of [
      ['project_id', 'projects'],
      ['intent_id', 'intents'],
      ['run_id', 'runs'],
    ]) {
      expect(up).toMatch(
        new RegExp(
          `FOREIGN KEY \\(tenant_id, ${col}\\)\\s+REFERENCES ${parent} \\(tenant_id, id\\)`,
        ),
      );
    }
  });

  it('has the D-05 section 9 indexes', () => {
    expect(up).toContain('ON cost_records (tenant_id, project_id, occurred_at)');
    expect(up).toContain('ON cost_records (tenant_id, intent_id)');
  });

  it('schema.ts knows the table and its tenant column', () => {
    expect(TABLE_COLUMNS.cost_records).toContain('source_ref');
    expect(TENANT_COLUMN.cost_records).toBe('tenant_id');
  });
});

describe('the cost queries pass the tenant guard', () => {
  const db = dummyDb().withPlugin(new TenantGuardPlugin(parseTenantId(TENANT_A)));

  it('rejects a read without the tenant condition', () => {
    expect(() => db.selectFrom('cost_records').selectAll().compile()).toThrow(/tenant/);
  });

  it('allows ON CONFLICT DO NOTHING, which cannot touch another tenant', () => {
    const insert = db
      .insertInto('cost_records')
      .values({
        tenant_id: TENANT_A,
        project_id: TENANT_A,
        intent_id: null,
        run_id: null,
        gate: null,
        agent: null,
        model: 'm',
        provider_type: 'api',
        input_tokens: 1,
        output_tokens: 1,
        cached_input_tokens: 0,
        cost_usd: '0.1',
        source_ref: 'r-1',
        occurred_at: new Date(),
      })
      .onConflict((oc) => oc.columns(['tenant_id', 'source_ref']).doNothing());
    expect(() => insert.compile()).not.toThrow();
  });
});
