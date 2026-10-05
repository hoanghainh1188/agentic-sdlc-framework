// D-08 E05 PR 2 (AC4, design/ADR-M51 §2.9; D-05 §7.4): the daily audit anchor. The document and
// its strict parse, the UTC date rules with a fake clock, the lock check, and the pass against an
// in-memory store and a fake chain: check first then write, once per tenant and day, 412 =
// already anchored, no backfill, each mismatch reason, no hash in a mismatch line or event.
// With PostgreSQL: tests/integration/db/audit-anchor.test.ts. Live: integration/openbao.
import { describe, expect, it } from 'vitest';

import {
  anchorBytes,
  anchorDate,
  anchorKey,
  anchorLockHolds,
  compareAnchor,
  parseAnchor,
  type AuditAnchor,
} from '../../packages/core/src/audit/anchor.js';
import { runAnchorPass, type AnchorPassDeps } from '../../packages/core/src/audit/anchor-pass.js';
import type { PlatformDatabase } from '../../packages/core/src/db/platform-database.js';
import { MemoryAnchorStore } from './memory-anchor-store.js';

const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';
const H = (c: string) => c.repeat(64);
const DAY = 86_400_000;

const anchor = (over: Partial<AuditAnchor> = {}): AuditAnchor => ({
  tenantId: T1,
  seq: 7,
  hash: H('a'),
  hashVersion: 1,
  anchoredAt: new Date('2026-10-04T12:00:00.000Z'),
  ...over,
});

describe('E05 PR 2: the anchor document', () => {
  it('is the canonical JSON of the five fields and parses back strictly', () => {
    const a = anchor();
    const bytes = anchorBytes(a);
    expect(bytes.toString()).toBe(
      `{"anchored_at":"2026-10-04T12:00:00.000Z","hash":"${H('a')}","hash_version":1,"seq":7,"tenant_id":"${T1}"}`,
    );
    expect(parseAnchor(bytes, T1, `${T1}/2026-10-04.json`)).toEqual(a);
  });

  it('refuses another tenant, another date, a non-canonical form, extra or bad fields', () => {
    const bytes = anchorBytes(anchor());
    const key = `${T1}/2026-10-04.json`;
    expect(parseAnchor(bytes, T2, `${T2}/2026-10-04.json`)).toBeNull();
    expect(parseAnchor(bytes, T1, `${T1}/2026-10-05.json`)).toBeNull();
    expect(parseAnchor(bytes, T1, `${T1}/2026-10-04.txt`)).toBeNull();
    const doc = JSON.parse(bytes.toString()) as Record<string, unknown>;
    expect(parseAnchor(Buffer.from(JSON.stringify(doc, null, 1)), T1, key)).toBeNull();
    for (const bad of [
      { ...doc, extra: 1 },
      { ...doc, seq: 0 },
      { ...doc, seq: '7' },
      { ...doc, hash: H('A') },
      { ...doc, hash_version: 0 },
      { ...doc, anchored_at: '2026-10-04T12:00:00Z' },
      { ...doc, tenant_id: T2 },
    ]) {
      const sorted = Object.fromEntries(Object.entries(bad).sort(([x], [y]) => (x < y ? -1 : 1)));
      expect(parseAnchor(Buffer.from(JSON.stringify(sorted)), T1, key)).toBeNull();
    }
    expect(parseAnchor(Buffer.from('not json'), T1, key)).toBeNull();
  });

  it('belongs to the UTC date of its time', () => {
    expect(anchorDate(new Date('2026-10-04T23:59:59.999Z'))).toBe('2026-10-04');
    expect(anchorDate(new Date('2026-10-05T00:00:00.000Z'))).toBe('2026-10-05');
    // 08:30 in Tokyo on the 5th is still the 4th in UTC.
    expect(anchorKey(T1, new Date('2026-10-05T08:30:00+09:00'))).toBe(`${T1}/2026-10-04.json`);
  });

  it('needs a COMPLIANCE lock of at least 730 days from the anchor', () => {
    const at = new Date('2026-10-04T00:00:00.000Z');
    expect(anchorLockHolds({ mode: 'COMPLIANCE', until: new Date(+at + 731 * DAY) }, at)).toBe(
      true,
    );
    expect(anchorLockHolds({ mode: 'COMPLIANCE', until: new Date(+at + 730 * DAY) }, at)).toBe(
      true,
    );
    expect(anchorLockHolds({ mode: 'COMPLIANCE', until: new Date(+at + 729 * DAY) }, at)).toBe(
      false,
    );
    expect(anchorLockHolds({ mode: 'GOVERNANCE', until: new Date(+at + 731 * DAY) }, at)).toBe(
      false,
    );
    expect(anchorLockHolds(null, at)).toBe(false);
  });

  it('matches the row at its seq, else names the reason', () => {
    expect(compareAnchor(anchor(), new Map([[7, H('a')]]))).toBeNull();
    expect(compareAnchor(anchor(), new Map([[7, H('b')]]))).toBe('hash_mismatch');
    expect(compareAnchor(anchor(), new Map())).toBe('seq_missing');
  });
});

interface Logged {
  level: string;
  event: string;
  fields: Record<string, unknown>;
}

/** A fake chain per tenant: seq → hash, plus the appended audit events. */
function world(start: string) {
  let now = new Date(start).getTime();
  const chains = new Map<string, Map<number, string>>([
    [T1, new Map([[1, H('1')]])],
    [T2, new Map([[1, H('2')]])],
  ]);
  const events: { tenant: string; action: string; payload: Record<string, unknown> }[] = [];
  const db = {
    system: { listTenants: () => Promise.resolve([...chains.keys()].map((id) => ({ id }))) },
    forTenant: (tenant: string) => ({
      audit: {
        latest: () => {
          const chain = chains.get(tenant)!;
          const seq = Math.max(0, ...chain.keys());
          return Promise.resolve(seq === 0 ? null : { seq, hash: chain.get(seq)!, hashVersion: 1 });
        },
        hashesAt: (seqs: number[]) => {
          const chain = chains.get(tenant)!;
          return Promise.resolve(
            new Map(seqs.filter((s) => chain.has(s)).map((s) => [s, chain.get(s)!])),
          );
        },
        append: (e: { action: string; payload: Record<string, unknown> }) => {
          events.push({ tenant, action: e.action, payload: e.payload });
          return Promise.resolve({});
        },
      },
    }),
  } as unknown as PlatformDatabase;
  const store = new MemoryAnchorStore(() => now);
  const logs: Logged[] = [];
  const deps: AnchorPassDeps = {
    db,
    store,
    logger: { log: (level, event, fields = {}) => logs.push({ level, event, fields }) },
    now: () => new Date(now),
    anchoredOn: new Map(),
  };
  return {
    deps,
    store,
    chains,
    events,
    logs,
    advance: (ms: number) => (now += ms),
    /** A new process: the memory of anchored days is gone. */
    restart: () => ({ ...deps, anchoredOn: new Map<string, string>() }),
  };
}

const mismatches = (logs: Logged[]) =>
  logs.filter((l) => l.event === 'worker.audit_anchor_mismatch');

describe('E05 PR 2: the anchor pass', () => {
  it('writes one anchor per tenant and UTC day, with the hash in the operator log line', async () => {
    const w = world('2026-10-04T10:00:00Z');
    const first = await runAnchorPass(w.deps);
    expect(first).toMatchObject({ tenants: 2, written: 2, skipped: 0, mismatched: 0, failed: 0 });
    expect([...w.store.versions.keys()].sort()).toEqual([
      `${T1}/2026-10-04.json`,
      `${T2}/2026-10-04.json`,
    ]);
    const line = w.logs.find(
      (l) => l.event === 'worker.audit_anchored' && l.fields.tenant_id === T1,
    );
    expect(line?.fields).toEqual({
      tenant_id: T1,
      date: '2026-10-04',
      outcome: 'written',
      seq: 1,
      hash: H('1'),
      hash_version: 1,
    });
    // Later the same day: nothing is read or written again.
    w.advance(13 * 3_600_000);
    const again = await runAnchorPass(w.deps);
    expect(again).toMatchObject({ skipped: 2, written: 0, checked: 0 });
    expect(w.store.puts).toBe(2);
    // After midnight UTC: a new key, and yesterday's anchors are checked.
    w.advance(2 * 3_600_000);
    w.chains.get(T1)!.set(2, H('3'));
    const next = await runAnchorPass(w.deps);
    expect(next).toMatchObject({ written: 2, checked: 2, mismatched: 0 });
    expect(w.store.versions.has(`${T1}/2026-10-05.json`)).toBe(true);
  });

  it('after a restart the same day: 412 is "already anchored", and the check runs again', async () => {
    const w = world('2026-10-04T10:00:00Z');
    await runAnchorPass(w.deps);
    w.chains.get(T1)!.set(2, H('3'));
    const result = await runAnchorPass(w.restart());
    expect(result).toMatchObject({ written: 0, exists: 2, checked: 2, mismatched: 0 });
    expect(w.store.versions.get(`${T1}/2026-10-04.json`)).toHaveLength(1);
  });

  it('writes even without new rows, and never back-fills missed days', async () => {
    const w = world('2026-10-01T10:00:00Z');
    await runAnchorPass(w.deps);
    w.advance(3 * DAY);
    await runAnchorPass(w.deps);
    const keys = [...w.store.versions.keys()].filter((k) => k.startsWith(T1)).sort();
    expect(keys).toEqual([`${T1}/2026-10-01.json`, `${T1}/2026-10-04.json`]);
  });

  it('skips a tenant without audit rows', async () => {
    const w = world('2026-10-04T10:00:00Z');
    w.chains.set(T2, new Map());
    const result = await runAnchorPass(w.deps);
    expect(result).toMatchObject({ written: 1, empty: 1 });
    expect(w.logs.some((l) => l.event === 'worker.audit_anchor_empty')).toBe(true);
  });

  it('finds a rewritten row, records one event in that tenant only, and never a hash', async () => {
    const w = world('2026-10-04T10:00:00Z');
    await runAnchorPass(w.deps);
    w.chains.get(T1)!.set(1, H('9'));
    w.advance(DAY);
    const result = await runAnchorPass(w.deps);
    expect(result).toMatchObject({ mismatched: 1, written: 2 });
    expect(mismatches(w.logs)).toEqual([
      {
        level: 'error',
        event: 'worker.audit_anchor_mismatch',
        fields: { tenant_id: T1, date: '2026-10-04', reason: 'hash_mismatch', seq: 1 },
      },
    ]);
    expect(w.events).toEqual([
      {
        tenant: T1,
        action: 'audit.anchor_mismatch',
        payload: { checked: 1, mismatched: 1, reason: 'hash_mismatch', first_seq: 1 },
      },
    ]);
    expect(JSON.stringify(mismatches(w.logs))).not.toMatch(/[0-9a-f]{64}/);
  });

  it('finds a shrunk chain (seq_missing)', async () => {
    const w = world('2026-10-04T10:00:00Z');
    w.chains.get(T1)!.set(2, H('3'));
    await runAnchorPass(w.deps);
    w.chains.get(T1)!.delete(2);
    w.advance(DAY);
    await runAnchorPass(w.deps);
    expect(mismatches(w.logs).map((l) => l.fields.reason)).toEqual(['seq_missing']);
  });

  it('finds a delete marker and a second version on a key (anchor_versions), and still reads the original', async () => {
    const w = world('2026-10-04T10:00:00Z');
    await runAnchorPass(w.deps);
    const key = `${T1}/2026-10-04.json`;
    w.store.deleteMarker(key);
    // With the marker on top, a put is accepted: a forged second version.
    expect(
      (
        await w.store.put(
          key,
          anchorBytes(
            anchor({ seq: 1, hash: H('f'), anchoredAt: new Date('2026-10-04T11:00:00Z') }),
          ),
        )
      ).outcome,
    ).toBe('written');
    w.advance(DAY);
    const result = await runAnchorPass(w.deps);
    // The key is reported once; the forged version also fails its comparison.
    expect(mismatches(w.logs).map((l) => l.fields.reason)).toEqual([
      'anchor_versions',
      'hash_mismatch',
    ]);
    expect(result.checked).toBe(3);
  });

  it('reports a malformed file and a file under the folder naming another tenant (anchor_invalid)', async () => {
    const w = world('2026-10-04T10:00:00Z');
    w.store.forge(
      `${T1}/2026-10-01.json`,
      anchorBytes(anchor({ tenantId: T2, seq: 1, anchoredAt: new Date('2026-10-01T00:00:00Z') })),
    );
    w.store.forge(`${T1}/notes.txt`, Buffer.from('x'));
    await runAnchorPass(w.deps);
    expect(mismatches(w.logs).map((l) => [l.fields.date, l.fields.reason])).toEqual([
      ['2026-10-01', 'anchor_invalid'],
      ['invalid', 'anchor_invalid'],
    ]);
    // Tenant 2 has its own folder: nothing of tenant 1 is compared with it.
    expect(w.events.map((e) => e.tenant)).toEqual([T1]);
  });

  it('logs a new anchor whose lock is not COMPLIANCE for 730 days', async () => {
    const w = world('2026-10-04T10:00:00Z');
    w.store.mode = 'GOVERNANCE';
    const result = await runAnchorPass(w.deps);
    expect(result.unlocked).toBe(2);
    expect(w.logs.filter((l) => l.event === 'worker.audit_anchor_unlocked')).toHaveLength(2);
  });

  it('a store outage fails the tenant, which is tried again on the next pass', async () => {
    const w = world('2026-10-04T10:00:00Z');
    w.store.down = true;
    const failed = await runAnchorPass(w.deps);
    expect(failed).toMatchObject({ failed: 4, written: 0 });
    expect(w.deps.anchoredOn.size).toBe(0);
    w.store.down = false;
    expect(await runAnchorPass(w.deps)).toMatchObject({ written: 2, failed: 0 });
  });
});
