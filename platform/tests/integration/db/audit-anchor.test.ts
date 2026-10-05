// D-08 E05 PR 2 (AC4, design/ADR-M51 §2.9; D-05 §7.4) on a live PostgreSQL: the daily audit
// anchor of each tenant's chain, with an in-memory store that behaves like the COMPLIANCE bucket.
//
// - One anchor per tenant and UTC day; a second pass or a restarted process writes nothing new.
// - A whole chain rewritten by an admin with every hash recomputed passes `audit verify`, but the
//   anchor of the day before no longer matches: `hash_mismatch`, one `audit.anchor_mismatch`
//   event in that tenant's chain only, no hash in the event.
// - A deleted last row: `seq_missing`.
// - Tenant isolation: each tenant's anchors are compared with its own chain only.
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  runAnchorPass,
  type AnchorPassDeps,
} from '../../../packages/core/src/audit/anchor-pass.js';
import { recordHash } from '../../../packages/core/src/audit/hash-chain.js';
import type { AuditLogRow } from '../../../packages/core/src/db/schema.js';
import { parseTenantId } from '../../../packages/core/src/db/tenant-id.js';
import type { TenantScope } from '../../../packages/core/src/db/tenant-scope.js';
import { MemoryAnchorStore } from '../../audit/memory-anchor-store.js';
import { createTestDatabase, describeDb, tamper, type TestDatabase } from './helpers.js';

const HASH = (c: string) => c.repeat(64);
const DAY = 86_400_000;

interface Seeded {
  readonly tenantId: string;
  readonly scope: TenantScope;
  readonly projectId: string;
  readonly userId: string;
}

describeDb('E05 PR 2: the daily audit anchor on PostgreSQL', () => {
  let t: TestDatabase;
  let a: Seeded;
  let b: Seeded;
  let now = Date.parse('2026-10-04T09:00:00.000Z');
  const store = new MemoryAnchorStore(() => now);
  const logs: { level: string; event: string; fields: Record<string, unknown> }[] = [];
  let deps: AnchorPassDeps;

  async function seed(slug: string): Promise<Seeded> {
    const tenant = await t.app.system.createTenant({ slug, name: slug });
    const scope = t.app.forTenant(parseTenantId(tenant.id));
    const project = await scope.projects.create({
      slug: 'shop',
      name: 'Shop',
      git_provider: 'github',
      repo_full_name: `${slug}/shop`,
    });
    const user = await scope.users.create({ display_name: 'Owner', email: 'o@example.com' });
    const s = { tenantId: tenant.id, scope, projectId: project.id, userId: user.id };
    await appendMany(s, 3);
    return s;
  }

  async function appendMany(s: Seeded, n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      await s.scope.audit.append({
        action: 'config.changed',
        actorType: 'human',
        actorId: s.userId,
        entityId: s.projectId,
        payload: { version: i + 1, config_hash: HASH('a') },
      });
    }
  }

  async function rows(s: Seeded): Promise<AuditLogRow[]> {
    return t.owner
      .selectFrom('audit_log')
      .selectAll()
      .where('tenant_id', '=', s.tenantId)
      .orderBy('seq')
      .execute();
  }

  const pass = (fresh = false) => runAnchorPass(fresh ? { ...deps, anchoredOn: new Map() } : deps);

  beforeAll(async () => {
    t = await createTestDatabase();
    a = await seed('tenant-a');
    b = await seed('tenant-b');
    deps = {
      db: t.app,
      store,
      logger: { log: (level, event, fields = {}) => logs.push({ level, event, fields }) },
      now: () => new Date(now),
      anchoredOn: new Map(),
    };
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  });

  it('writes one anchor per tenant and UTC day of its last row', async () => {
    expect(await pass()).toMatchObject({ written: 2, mismatched: 0, failed: 0 });
    now += 3_600_000;
    expect(await pass()).toMatchObject({ skipped: 2, written: 0 });
    // A restarted process: the key is there (412), nothing new is stored.
    expect(await pass(true)).toMatchObject({ written: 0, exists: 2, checked: 2, mismatched: 0 });
    const keyA = `${a.tenantId}/2026-10-04.json`;
    expect(store.versions.get(keyA)).toHaveLength(1);
    const stored = JSON.parse(store.versions.get(keyA)![0]!.bytes!.toString()) as {
      seq: number;
      hash: string;
    };
    const last = (await rows(a)).at(-1)!;
    expect(stored).toMatchObject({ seq: Number(last.seq), hash: last.hash, tenant_id: a.tenantId });
  });

  it('a new day: the earlier anchors match and a new anchor is written, also without new rows', async () => {
    now += DAY;
    await appendMany(a, 2);
    expect(await pass()).toMatchObject({ written: 2, checked: 2, mismatched: 0 });
    expect(store.versions.has(`${b.tenantId}/2026-10-05.json`)).toBe(true);
    // The audit log holds no anchor event: everything matched.
    expect((await rows(a)).some((r) => r.action === 'audit.anchor_mismatch')).toBe(false);
  });

  it('finds a whole chain rewritten by an admin that `audit verify` accepts', async () => {
    // Rewrite tenant A's chain from seq 1: another payload, every hash recomputed and linked.
    const chain = await rows(a);
    let prev = '0'.repeat(64);
    for (const row of chain) {
      const payload =
        Number(row.seq) === 1 ? { ...row.payload, config_hash: HASH('b') } : row.payload;
      const hash = recordHash({
        hashVersion: row.hash_version,
        tenantId: row.tenant_id,
        seq: Number(row.seq),
        actorType: row.actor_type,
        actorId: row.actor_id,
        action: row.action,
        entityType: row.entity_type,
        entityId: row.entity_id,
        payload,
        occurredAt: row.occurred_at,
        prevHash: prev,
      });
      await tamper(
        t.name,
        `UPDATE audit_log SET payload = $1, prev_hash = $2, hash = $3 WHERE tenant_id = $4 AND seq = $5`,
        [JSON.stringify(payload), prev, hash, row.tenant_id, row.seq],
      );
      prev = hash;
    }
    expect((await a.scope.audit.verify()).broken).toBeUndefined();

    now += DAY;
    logs.length = 0;
    const result = await pass();
    expect(result.mismatched).toBe(2);
    const lines = logs.filter((l) => l.event === 'worker.audit_anchor_mismatch');
    expect(lines.map((l) => [l.fields.tenant_id, l.fields.date, l.fields.reason])).toEqual([
      [a.tenantId, '2026-10-04', 'hash_mismatch'],
      [a.tenantId, '2026-10-05', 'hash_mismatch'],
    ]);
    expect(JSON.stringify(lines)).not.toMatch(/[0-9a-f]{64}/);
    // One event, in tenant A's chain only; its payload carries no hash.
    const eventsA = (await rows(a)).filter((r) => r.action === 'audit.anchor_mismatch');
    expect(eventsA.map((r) => r.payload)).toEqual([
      { checked: 2, mismatched: 2, reason: 'hash_mismatch', first_seq: 3 },
    ]);
    expect((await rows(b)).some((r) => r.action === 'audit.anchor_mismatch')).toBe(false);
    // The chain still verifies with the event appended.
    expect((await a.scope.audit.verify()).broken).toBeUndefined();
  });

  it('finds a chain that shrank (seq_missing), in that tenant only', async () => {
    const last = (await rows(b)).at(-1)!;
    await tamper(t.name, `DELETE FROM audit_log WHERE tenant_id = $1 AND seq = $2`, [
      b.tenantId,
      last.seq,
    ]);
    now += DAY;
    logs.length = 0;
    await pass();
    const lines = logs.filter((l) => l.event === 'worker.audit_anchor_mismatch');
    // Tenant B's three anchors (seq 3 each day) lost their row; tenant A's old ones still differ.
    const linesB = lines.filter((l) => l.fields.tenant_id === b.tenantId);
    expect(linesB.map((l) => l.fields.reason)).toEqual([
      'seq_missing',
      'seq_missing',
      'seq_missing',
    ]);
    expect(
      lines.filter((l) => l.fields.tenant_id === a.tenantId).map((l) => l.fields.reason),
    ).toEqual(['hash_mismatch', 'hash_mismatch']);
    const eventsB = (await rows(b)).filter((r) => r.action === 'audit.anchor_mismatch');
    expect(eventsB).toHaveLength(1);
    expect(eventsB[0]!.payload).toMatchObject({ reason: 'seq_missing' });
  });
});
