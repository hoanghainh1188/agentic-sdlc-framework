// D-08 B02 (static part): migration 0003 SQL, vocabulary drift against @sdlc/contracts, and the
// registry queries pass the tenant guard. Live behaviour: tests/integration/db/registry.test.ts.
import { GATE_CHECK_MODES, GATE_REASON_CODES, type GateCheckMode } from '@sdlc/contracts';
import { sql } from 'kysely';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { DbError, translatePgError } from '../../packages/core/src/db/errors.js';
import { MIGRATIONS } from '../../packages/core/src/db/migrations/index.js';
import { TenantGuardPlugin } from '../../packages/core/src/db/tenant-guard-plugin.js';
import { parseTenantId } from '../../packages/core/src/db/tenant-id.js';
import { DB_ENUMS } from '../../packages/core/src/db/vocabulary.js';
import { dummyDb, SOME_ID, TENANT_A } from './dummy.js';

const up = MIGRATIONS['0003-registry']!.statements.up.join(';\n');

function enumValues(name: string): string[] {
  const match = new RegExp(`CREATE TYPE ${name} AS ENUM\\s*\\(([^)]*)\\)`).exec(up);
  if (!match) throw new Error(`enum ${name} not found`);
  return [...match[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

describe('migration 0003: registry', () => {
  it('lists the same enum values as @sdlc/contracts (via DB_ENUMS)', () => {
    for (const name of [
      'gate_code',
      'risk_tier',
      'autonomy_level',
      'change_flag',
      'intent_status',
      'gate_decision',
      'gate_check_mode',
      'gate_reason_code',
      'event_source',
    ] as const) {
      expect(enumValues(name), name).toEqual([...DB_ENUMS[name]]);
    }
  });

  it('GATE_CHECK_MODES is exactly the GateCheckMode type (QUESTIONS #6)', () => {
    expectTypeOf<(typeof GATE_CHECK_MODES)[number]>().toEqualTypeOf<GateCheckMode>();
  });

  it('gate_decisions is append-only: triggers and SELECT, INSERT grants only (D-05 D3)', () => {
    expect(up).toMatch(
      /CREATE TRIGGER gate_decisions_no_update_delete BEFORE UPDATE OR DELETE ON gate_decisions\s+FOR EACH ROW EXECUTE FUNCTION forbid_mutation\(\)/,
    );
    expect(up).toMatch(
      /CREATE TRIGGER gate_decisions_no_truncate BEFORE TRUNCATE ON gate_decisions\s+FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation\(\)/,
    );
    const grants = [...up.matchAll(/GRANT ([^;]*?) ON ([^;]*?) TO platform_app/g)].map((m) => [
      m[1],
      m[2],
    ]);
    expect(grants).toEqual([
      ['SELECT, INSERT', 'intents, spec_refs, plans, gate_decisions'],
      ['UPDATE (current_gate, status, issue_number, pr_number, updated_at)', 'intents'],
    ]);
  });

  it('gate_decisions holds no free-text reason: a reason code and an https link (ADR-M20)', () => {
    const table = /CREATE TABLE gate_decisions \(([\s\S]*?)\n {5}\)/.exec(up)![1]!;
    expect(table).not.toMatch(/^\s+reason\s/m);
    expect(table).toMatch(/reason_code\s+gate_reason_code,/);
    expect(table).toMatch(/reason_ref\s+text CHECK \(reason_ref ~ '\^https:/);
    expect(table).toMatch(
      /decision NOT IN \('reject', 'request_changes', 'block', 'fail', 'void'\) OR reason_code IS NOT NULL/,
    );
    expect(GATE_REASON_CODES).toContain('other');
  });

  it('has the approval binding, POLICY, agent and void constraints', () => {
    expect(up).toMatch(/CONSTRAINT gate_decisions_no_agent CHECK \(actor_type <> 'agent'\)/);
    expect(up).toMatch(/oversight_mode <> 'POLICY' OR \(gate = 'G4' AND actor_type = 'system'\)/);
    expect(up).toMatch(/approver_role IS NOT NULL AND expires_at IS NOT NULL/);
    expect(up).toMatch(/\(decision = 'void'\) = \(voids_decision_id IS NOT NULL\)/);
    expect(up).toMatch(/CREATE TRIGGER gate_decisions_check_void BEFORE INSERT ON gate_decisions/);
  });

  it('SDA04 maps to invalid_value', () => {
    expect(() => translatePgError({ code: 'SDA04' })).toThrow(
      expect.objectContaining({ name: 'DbError', code: 'invalid_value' }) as DbError,
    );
  });
});

describe('the registry queries pass the tenant guard', () => {
  const db = dummyDb().withPlugin(new TenantGuardPlugin(parseTenantId(TENANT_A)));

  it('accepts the intent code query and the intent lock', () => {
    expect(() =>
      db
        .selectFrom('intents')
        .select(sql<number | null>`max(substring(code from 10)::int)`.as('last'))
        .where('tenant_id', '=', TENANT_A)
        .where('code', 'like', 'INT-2026-%')
        .compile(),
    ).not.toThrow();
    expect(() =>
      db
        .selectNoFrom(sql<null>`pg_advisory_xact_lock(1::int4, hashtext(${SOME_ID}))`.as('locked'))
        .compile(),
    ).not.toThrow();
  });

  it('rejects a registry read without the tenant condition', () => {
    for (const table of ['intents', 'spec_refs', 'plans', 'gate_decisions'] as const) {
      expect(() => db.selectFrom(table).selectAll().compile(), table).toThrow(/tenant/);
    }
  });
});
