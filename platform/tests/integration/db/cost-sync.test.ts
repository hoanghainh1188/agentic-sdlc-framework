// D-08 C12 on a live PostgreSQL, with a fake model gateway whose spend log fills in late, like
// LiteLLM's batched writes (design/ADR-M24 §2.5, QUESTIONS #197, #225).
// AC1: the loop syncs on its schedule with the real Cost Controller; nothing is counted twice.
// AC2: a call written after the run-end sync is recorded once; a running run's spend appears;
// a run longer than the look-back is synced whole once more after it ends (another tenant too).
// The lock: only one process syncs at a time.
import type {
  CreateRunKey,
  ModelGateway,
  ModelRef,
  SpendRecord,
  TenantBudget,
  VirtualKey,
} from '@sdlc/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CostSyncLoop } from '../../../apps/worker/src/cost-sync-loop.js';
import type { CostSyncSettings } from '../../../apps/worker/src/settings.js';
import { CostController } from '../../../packages/core/src/cost/index.js';
import { seedRun, type SeededRun } from '../cost-seed.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

const MODEL = 'claude-haiku-4-5';
const MIN = 60_000;
const SETTINGS: CostSyncSettings = {
  intervalMs: 5 * MIN,
  lookbackMs: 120 * MIN,
  catchUpMs: 1440 * MIN,
  settleMs: 30 * MIN,
};

/** The gateway's spend log: rows appear when the test writes them, filtered by call time. */
class LateSpendGateway implements ModelGateway {
  spend: SpendRecord[] = [];
  readonly models: ModelRef[] = [{ model: MODEL, providerType: 'api' }];

  ensureTenantBudget(input: TenantBudget) {
    return Promise.resolve({ tenantGroupId: `sdlc-tenant-${input.tenantSlug}` });
  }
  createRunKey(input: CreateRunKey): Promise<VirtualKey> {
    return Promise.resolve({
      keyId: 'f'.repeat(64),
      key: { reveal: () => 'sk-virtual' },
      expiresAt: new Date(Date.now() + input.durationMinutes * MIN),
    });
  }
  revokeKey() {
    return Promise.resolve();
  }
  revokeRunKey() {
    return Promise.resolve();
  }
  getSpend() {
    return Promise.resolve({ spendUsd: '0', maxBudgetUsd: null });
  }
  listModels() {
    return Promise.resolve(this.models);
  }
  listSpend(range: { readonly from: Date; readonly to: Date }) {
    return Promise.resolve({
      records: this.spend.filter((r) => r.occurredAt >= range.from && r.occurredAt < range.to),
      unreadable: 0,
    });
  }
}

describeDb('C12: the scheduled spend sync on PostgreSQL', () => {
  let t: TestDatabase;
  let tenants = 0;
  let refs = 0;
  let now = new Date();

  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);
  afterAll(() => t?.drop());

  const seed = (): Promise<SeededRun> =>
    seedRun(t.app, { slug: `sync-${String(++tenants)}`, models: [MODEL], now: new Date() });

  const call = (s: SeededRun, occurredAt: Date, costUsd = '0.0012'): SpendRecord => ({
    sourceRef: `chatcmpl-c12-${String(++refs)}`,
    model: MODEL,
    status: 'success',
    inputTokens: 1000,
    outputTokens: 100,
    cachedInputTokens: 0,
    costUsd,
    occurredAt,
    labels: {
      tenant: s.slug,
      project: 'shop',
      intent_id: s.intentCode,
      run_id: s.runId,
      gate: 'G4',
      agent: 'coder-openhands',
      data_class: 'internal',
    },
  });

  function world() {
    const gateway = new LateSpendGateway();
    const controller = new CostController({ gateway, db: t.app, now: () => now });
    const logs: { event: string; fields: Record<string, unknown> }[] = [];
    const loop = new CostSyncLoop({
      sync: (range) => controller.syncSpend(range),
      earliestStartOfRunsEndedSince: (since) => t.app.system.earliestStartOfRunsEndedSince(since),
      withLock: (fn) => t.app.system.withSpendSyncLock(fn),
      now: () => now,
      logger: { log: (_level, event, fields) => logs.push({ event, fields: { ...fields } }) },
      settings: SETTINGS,
    });
    return { gateway, controller, loop, logs };
  }

  const ago = (minutes: number): Date => new Date(now.getTime() - minutes * MIN);
  const total = (s: SeededRun) => s.scope.costRecords.totalForIntent(s.intentId);

  it('AC2: a running run shows its spend after one pass; its run counts as in progress', async () => {
    now = new Date();
    const w = world();
    const s = await seed();
    await s.scope.runs.transition(s.runId, {
      from: ['queued'],
      to: 'running',
      now,
      startedAt: now,
    });
    w.gateway.spend.push(call(s, ago(3)));
    await expect(w.loop.tick()).resolves.toMatchObject({ outcome: 'synced' });
    expect(await total(s)).toBe('0.001200');
    expect(await s.scope.costRecords.countRuns({ intentId: s.intentId }, ['running'])).toBe(1);
  });

  it('AC1, AC2: a call written after the run-end sync is recorded once, never twice', async () => {
    now = new Date();
    const w = world();
    const s = await seed();
    await w.loop.tick(); // The start pass (catch-up window).
    w.gateway.spend.push(call(s, ago(4)));
    await s.scope.runs.transition(s.runId, {
      from: ['queued'],
      to: 'succeeded',
      now,
      finishedAt: now,
    });
    // The run-end sync of the workflow (`endRunKey`): records what the gateway has written so far.
    await w.controller.endRunKey({ runId: s.runId, syncFrom: ago(60) });
    expect(await total(s)).toBe('0.001200');
    // LiteLLM writes the last call of the run later, in a batch.
    w.gateway.spend.push(call(s, ago(1)));
    now = new Date(now.getTime() + 5 * MIN);
    await w.loop.tick();
    expect(await total(s)).toBe('0.002400');
    expect(w.logs.at(-1)).toMatchObject({
      event: 'worker.cost_synced',
      fields: { inserted: 1, duplicates: 1 },
    });
    // The next pass reads the same rows again and inserts nothing.
    now = new Date(now.getTime() + 5 * MIN);
    await w.loop.tick();
    expect(await total(s)).toBe('0.002400');
    expect(w.logs.at(-1)).toMatchObject({ fields: { inserted: 0, duplicates: 2 } });
  });

  it('AC2: a run longer than the look-back is synced whole after it ends, for every tenant', async () => {
    now = new Date();
    const w = world();
    const first = await seed();
    const other = await seed();
    await w.loop.tick(); // The start pass; nothing is in the spend log yet.
    // The other tenant's run started six hours ago; its early calls were not written in time.
    await sql`UPDATE runs SET created_at = ${ago(360)} WHERE id = ${other.runId}`.execute(t.owner);
    await other.scope.runs.transition(other.runId, {
      from: ['queued'],
      to: 'succeeded',
      now,
      finishedAt: now,
    });
    w.gateway.spend.push(call(other, ago(300)), call(first, ago(10)));
    expect(await t.app.system.earliestStartOfRunsEndedSince(ago(30))).toEqual(ago(360));
    now = new Date(now.getTime() + 5 * MIN);
    await expect(w.loop.tick()).resolves.toMatchObject({ outcome: 'synced' });
    expect(await total(other)).toBe('0.001200');
    expect(await total(first)).toBe('0.001200');
    // Out of the settle window, the run's old calls are no longer read (they are already recorded).
    expect(await t.app.system.earliestStartOfRunsEndedSince(new Date(now.getTime() + MIN))).toBe(
      null,
    );
  });

  describe('withSpendSyncLock', () => {
    it('one holder at a time across connections; released after the pass and after an error', async () => {
      let release: () => void = () => undefined;
      let started = false;
      const held = t.app.system.withSpendSyncLock(
        () =>
          new Promise<string>((resolve) => {
            started = true;
            release = () => resolve('first');
          }),
      );
      // `fn` runs only once the first holder has the lock.
      while (!started) await new Promise((resolve) => setImmediate(resolve));
      await expect(
        t.app.system.withSpendSyncLock(() => Promise.resolve('second')),
      ).resolves.toEqual({
        ran: false,
      });
      release();
      await expect(held).resolves.toEqual({ ran: true, value: 'first' });
      await expect(
        t.app.system.withSpendSyncLock(() => Promise.reject(new Error('boom'))),
      ).rejects.toThrow('boom');
      await expect(t.app.system.withSpendSyncLock(() => Promise.resolve('third'))).resolves.toEqual(
        {
          ran: true,
          value: 'third',
        },
      );
    });

    it('a second loop is skipped while the first syncs', async () => {
      now = new Date();
      const a = world();
      const b = world();
      let release: (() => void) | undefined;
      const blocking = new CostSyncLoop({
        sync: async (range) => {
          await new Promise<void>((resolve) => (release = resolve));
          return a.controller.syncSpend(range);
        },
        earliestStartOfRunsEndedSince: () => Promise.resolve(null),
        withLock: (fn) => t.app.system.withSpendSyncLock(fn),
        now: () => now,
        logger: { log: () => undefined },
        settings: { ...SETTINGS, catchUpMs: 60 * MIN, lookbackMs: 60 * MIN },
      });
      const first = blocking.tick();
      // `sync` runs only once the first loop holds the lock.
      while (release === undefined) await new Promise((resolve) => setImmediate(resolve));
      await expect(b.loop.tick()).resolves.toEqual({ outcome: 'busy' });
      expect(b.logs).toEqual([{ event: 'worker.cost_sync_busy', fields: {} }]);
      release();
      await expect(first).resolves.toMatchObject({ outcome: 'synced' });
    });
  });
});
