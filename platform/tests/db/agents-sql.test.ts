// Migration 0008 (task C10, design/ADR-M31) without a database: the status enum, the trigger's
// status moves, the grants and the foreign key on runs. Behaviour on PostgreSQL is in
// tests/integration/db/agents.test.ts.
import { AGENT_STATUSES } from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

import { AGENT_STATUS_MOVES } from '../../packages/core/src/agents/rules.js';
import { DbError, translatePgError } from '../../packages/core/src/db/errors.js';
import { MIGRATIONS } from '../../packages/core/src/db/migrations/index.js';
import { TenantGuardPlugin } from '../../packages/core/src/db/tenant-guard-plugin.js';
import { parseTenantId } from '../../packages/core/src/db/tenant-id.js';
import { DB_ENUMS } from '../../packages/core/src/db/vocabulary.js';
import { dummyDb, TENANT_A } from './dummy.js';

const up = MIGRATIONS['0008-agents']!.statements.up.join(';\n');

describe('migration 0008: agents', () => {
  it('agent_status lists the same values as @sdlc/contracts (via DB_ENUMS)', () => {
    const match = /CREATE TYPE agent_status AS ENUM\s*\(([^)]*)\)/.exec(up)!;
    expect([...match[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1])).toEqual([...AGENT_STATUSES]);
    expect(DB_ENUMS.agent_status).toBe(AGENT_STATUSES);
  });

  it('the trigger allows exactly AGENT_STATUS_MOVES', () => {
    const moves = [
      ...up.matchAll(/OLD\.status = '([a-z]+)'\s+AND NEW\.status IN \(([^)]*)\)/g),
    ].map((m) => [m[1], [...m[2]!.matchAll(/'([^']+)'/g)].map((v) => v[1])]);
    expect(Object.fromEntries(moves)).toEqual(
      Object.fromEntries(Object.entries(AGENT_STATUS_MOVES).filter(([, to]) => to.length > 0)),
    );
    expect(up).toMatch(/IF OLD\.status = 'retired' THEN/);
    expect(up).toMatch(/CREATE TRIGGER agents_changes BEFORE UPDATE ON agents/);
  });

  it('never grants DELETE; UPDATE never reaches the identity (agent_key, tenant_id)', () => {
    expect(up).toMatch(/GRANT SELECT, INSERT ON agents TO platform_app/);
    const update = /GRANT UPDATE \(([^)]*)\)\s+ON agents/.exec(up)![1]!;
    expect(update).not.toMatch(/agent_key|tenant_id|created_at|\bid\b/);
    expect(up).not.toMatch(/GRANT[^;]*DELETE/);
  });

  it('adds the foreign key runs → agents (QUESTIONS #32)', () => {
    expect(up).toMatch(
      /ALTER TABLE runs ADD CONSTRAINT runs_agent_fkey FOREIGN KEY \(tenant_id, agent_id\)/,
    );
  });

  it('holds no free-text column: every text column has a format CHECK', () => {
    for (const column of ['agent_key', 'version', 'model_ref', 'instructions_ref']) {
      expect(up, column).toMatch(new RegExp(`${column}\\s+text[^,]*CHECK`));
    }
  });

  it('SDA09 maps to immutable', () => {
    expect(() => translatePgError({ code: 'SDA09' })).toThrow(
      expect.objectContaining({ name: 'DbError', code: 'immutable' }) as DbError,
    );
  });
});

describe('the agent queries pass the tenant guard', () => {
  const db = dummyDb().withPlugin(new TenantGuardPlugin(parseTenantId(TENANT_A)));

  it('rejects an agent read without the tenant condition', () => {
    expect(() => db.selectFrom('agents').selectAll().compile()).toThrow(
      expect.objectContaining({ code: 'missing_tenant_filter' }),
    );
  });

  it('accepts a read with the tenant condition', () => {
    expect(() =>
      db.selectFrom('agents').selectAll().where('tenant_id', '=', TENANT_A).compile(),
    ).not.toThrow();
  });
});
