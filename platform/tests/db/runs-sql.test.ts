// D-08 C02 (static part): migration 0004 SQL (runs, run_contracts, run_events), vocabulary drift
// against @sdlc/contracts, and the run queries pass the tenant guard. Live behaviour:
// tests/integration/db/runs.test.ts.
import { FINAL_RUN_STATUSES, RUN_STATUSES } from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

import { DbError, translatePgError } from '../../packages/core/src/db/errors.js';
import { MIGRATIONS } from '../../packages/core/src/db/migrations/index.js';
import { TenantGuardPlugin } from '../../packages/core/src/db/tenant-guard-plugin.js';
import { parseTenantId } from '../../packages/core/src/db/tenant-id.js';
import { DB_ENUMS } from '../../packages/core/src/db/vocabulary.js';
import { dummyDb, TENANT_A } from './dummy.js';

const up = MIGRATIONS['0004-runs']!.statements.up.join(';\n');

describe('migration 0004: runs', () => {
  it('run_status lists the same values as @sdlc/contracts (via DB_ENUMS)', () => {
    const match = /CREATE TYPE run_status AS ENUM\s*\(([^)]*)\)/.exec(up)!;
    expect([...match[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1])).toEqual([
      ...DB_ENUMS.run_status,
    ]);
    expect(DB_ENUMS.run_status).toBe(RUN_STATUSES);
  });

  it('the final-status trigger lists exactly FINAL_RUN_STATUSES', () => {
    const body = /IF OLD\.status IN \(([^)]*)\)/.exec(up)!;
    expect([...body[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1])).toEqual([...FINAL_RUN_STATUSES]);
    expect(up).toMatch(/CREATE TRIGGER runs_final_status_is_final BEFORE UPDATE ON runs/);
  });

  it('run_events is append-only: triggers (AC3)', () => {
    expect(up).toMatch(
      /CREATE TRIGGER run_events_no_update_delete BEFORE UPDATE OR DELETE ON run_events\s+FOR EACH ROW EXECUTE FUNCTION forbid_mutation\(\)/,
    );
    expect(up).toMatch(
      /CREATE TRIGGER run_events_no_truncate BEFORE TRUNCATE ON run_events\s+FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation\(\)/,
    );
  });

  it('grants SELECT, INSERT on all three tables and UPDATE on run state columns only', () => {
    const grants = [...up.matchAll(/GRANT ([^;]*?) ON ([^;]*?) TO platform_app/g)].map((m) => [
      m[1]!.replace(/\s+/g, ' '),
      m[2],
    ]);
    expect(grants).toEqual([
      ['SELECT, INSERT', 'runs, run_contracts, run_events'],
      [
        'UPDATE (status, stop_reason, head_sha, started_at, finished_at, iterations, killed_by, updated_at)',
        'runs',
      ],
    ]);
  });

  it('run_events payloads are checked by run_event_payload_is_coded, which refuses "@"', () => {
    expect(up).toMatch(/payload\s+jsonb NOT NULL CHECK \(run_event_payload_is_coded\(payload\)\)/);
    const pattern = /\(e\.value #>> '\{\}'\) ~ '([^']+)'/.exec(up)![1]!;
    expect(pattern).toBe('^[A-Za-z0-9._:/-]{1,128}$');
    expect(new RegExp(pattern).test('tanaka@example.co.jp')).toBe(false);
    expect(new RegExp(pattern).test('customer asked')).toBe(false);
    expect(new RegExp(pattern).test('stopped_budget')).toBe(true);
  });

  it('runs.stop_reason is a code, not free text; agent_id gets its foreign key in 0008 (QUESTIONS #32)', () => {
    expect(up).toMatch(
      /stop_reason\s+text CHECK \(stop_reason ~ '\^\[a-z\]\[a-z0-9_\]\{0,63\}\$'\)/,
    );
    expect(up).not.toMatch(/REFERENCES agents/);
    expect(MIGRATIONS['0008-agents']!.statements.up.join('\n')).toMatch(
      /ALTER TABLE runs ADD CONSTRAINT runs_agent_fkey FOREIGN KEY \(tenant_id, agent_id\)\s+REFERENCES agents \(tenant_id, id\) ON DELETE RESTRICT/,
    );
  });

  it('SDA05 maps to immutable', () => {
    expect(() => translatePgError({ code: 'SDA05' })).toThrow(
      expect.objectContaining({ name: 'DbError', code: 'immutable' }) as DbError,
    );
  });
});

describe('the run queries pass the tenant guard', () => {
  const db = dummyDb().withPlugin(new TenantGuardPlugin(parseTenantId(TENANT_A)));

  it('rejects a run read without the tenant condition', () => {
    for (const table of ['runs', 'run_contracts', 'run_events'] as const) {
      expect(() => db.selectFrom(table).selectAll().compile(), table).toThrow(/tenant/);
      expect(() =>
        db.selectFrom(table).selectAll().where('tenant_id', '=', TENANT_A).compile(),
      ).not.toThrow();
    }
  });
});
