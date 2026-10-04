// D-08 C12 AC1, AC3 (scheduling part): the scheduled spend sync loop: its window (catch-up, look-back,
// recently ended runs), slices under the gateway's page cap, a failed pass retried from the slice
// that failed, the gap warning, the lock, and codes and counts only in the logs (design/ADR-M24 §2.5,
// QUESTIONS #225). Fake clock, `tick()` called directly. The database part:
// tests/integration/db/cost-sync.test.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  COST_SYNC_SLICE_MS,
  CostSyncLoop,
  type CostSyncLoopDeps,
} from '../../apps/worker/src/cost-sync-loop.js';
import type { CostSyncSettings } from '../../apps/worker/src/settings.js';

const MIN = 60_000;
const SETTINGS: CostSyncSettings = {
  intervalMs: 5 * MIN,
  lookbackMs: 120 * MIN,
  catchUpMs: 1440 * MIN,
  settleMs: 30 * MIN,
};
const T0 = new Date('2026-10-04T12:00:00Z');

interface Range {
  readonly from: Date;
  readonly to: Date;
}

function harness(settings: CostSyncSettings = SETTINGS) {
  const state = {
    now: T0,
    ranges: [] as Range[],
    /** Sync calls (1-based, over the whole test) that fail. */
    failOn: new Set<number>(),
    calls: 0,
    busy: false,
    lockError: false,
    endedStart: null as Date | null,
    endedSince: [] as Date[],
  };
  const logs: { level: string; event: string; fields: Record<string, unknown> }[] = [];
  const deps: CostSyncLoopDeps = {
    sync: (range) => {
      state.calls += 1;
      if (state.failOn.has(state.calls)) {
        return Promise.reject(Object.assign(new Error('LiteLLM text'), { code: 'truncated' }));
      }
      state.ranges.push(range);
      return Promise.resolve({
        seen: 3,
        inserted: 2,
        duplicates: 1,
        skipped: { unknown_run: 1 },
      });
    },
    earliestStartOfRunsEndedSince: (since) => {
      state.endedSince.push(since);
      return Promise.resolve(state.endedStart);
    },
    withLock: async (fn) => {
      if (state.lockError) throw Object.assign(new Error('pg'), { code: 'unavailable' });
      if (state.busy) return { ran: false };
      return { ran: true, value: await fn() };
    },
    now: () => state.now,
    logger: { log: (level, event, fields) => logs.push({ level, event, fields: { ...fields } }) },
    settings,
  };
  const loop = new CostSyncLoop(deps);
  const advance = (ms: number): void => {
    state.now = new Date(state.now.getTime() + ms);
  };
  return { loop, state, logs, advance };
}

/** The ranges must cover [from, to) without a hole, oldest first, each at most one slice. */
function expectContiguous(ranges: readonly Range[], from: Date, to: Date): void {
  expect(ranges[0]?.from).toEqual(from);
  expect(ranges.at(-1)?.to).toEqual(to);
  for (const [i, r] of ranges.entries()) {
    expect(r.to.getTime() - r.from.getTime()).toBeLessThanOrEqual(COST_SYNC_SLICE_MS);
    if (i > 0) expect(r.from).toEqual(ranges[i - 1]?.to);
  }
}

const minus = (date: Date, ms: number): Date => new Date(date.getTime() - ms);

afterEach(() => {
  vi.useRealTimers();
});

describe('cost sync loop: the window', () => {
  it('the first pass after a start reads the catch-up window, in slices, oldest first', async () => {
    const h = harness();
    await expect(h.loop.tick()).resolves.toEqual({
      outcome: 'synced',
      from: minus(T0, 1440 * MIN),
      to: T0,
    });
    expect(h.state.ranges).toHaveLength(24);
    expectContiguous(h.state.ranges, minus(T0, 1440 * MIN), T0);
    expect(h.logs).toEqual([
      {
        level: 'info',
        event: 'worker.cost_synced',
        fields: {
          window_minutes: 1440,
          slices: 24,
          seen: 72,
          inserted: 48,
          duplicates: 24,
          skipped_unknown_run: 24,
        },
      },
    ]);
  });

  it('later passes read the look-back window (late spend-log rows of the last two hours)', async () => {
    const h = harness();
    await h.loop.tick();
    h.state.ranges = [];
    h.advance(5 * MIN);
    const pass = await h.loop.tick();
    expect(pass).toEqual({
      outcome: 'synced',
      from: minus(h.state.now, 120 * MIN),
      to: h.state.now,
    });
    expectContiguous(h.state.ranges, minus(h.state.now, 120 * MIN), h.state.now);
    expect(h.state.endedSince.at(-1)).toEqual(minus(h.state.now, 30 * MIN));
  });

  it('reaches back to the start of a run that ended within the settle window', async () => {
    const h = harness();
    await h.loop.tick();
    h.advance(5 * MIN);
    h.state.endedStart = minus(h.state.now, 300 * MIN);
    const pass = await h.loop.tick();
    expect(pass).toMatchObject({ outcome: 'synced', from: minus(h.state.now, 300 * MIN) });
  });

  it('never reaches back further than the catch-up window for an ended run, without a gap warning', async () => {
    const h = harness();
    await h.loop.tick();
    h.advance(5 * MIN);
    h.state.endedStart = minus(h.state.now, 3000 * MIN);
    const pass = await h.loop.tick();
    expect(pass).toMatchObject({ outcome: 'synced', from: minus(h.state.now, 1440 * MIN) });
    expect(h.logs.some((l) => l.event === 'worker.cost_sync_gap')).toBe(false);
  });
});

describe('cost sync loop: failures (AC3)', () => {
  it('a failed slice fails the pass; the next pass starts at that slice, the slices before stay', async () => {
    const h = harness();
    await h.loop.tick();
    h.advance(5 * MIN);
    h.state.ranges = [];
    // The second slice of the look-back fails (for example `truncated`: the page cap).
    h.state.failOn.add(h.state.calls + 2);
    const failedAt = minus(h.state.now, 60 * MIN);
    await expect(h.loop.tick()).resolves.toEqual({ outcome: 'failed', retryFrom: failedAt });
    expect(h.state.ranges).toHaveLength(1);
    expect(h.logs.at(-1)).toEqual({
      level: 'error',
      event: 'worker.cost_sync_failed',
      fields: { error: 'truncated', slices_done: 1, window_minutes: 120 },
    });
    // Ten hours later the gateway answers again: the retry reaches back past the look-back.
    h.advance(600 * MIN);
    h.state.ranges = [];
    const retried = await h.loop.tick();
    expect(retried).toEqual({ outcome: 'synced', from: failedAt, to: h.state.now });
    expectContiguous(h.state.ranges, failedAt, h.state.now);
    // Back to normal afterwards.
    h.advance(5 * MIN);
    await expect(h.loop.tick()).resolves.toMatchObject({
      from: minus(h.state.now, 120 * MIN),
    });
  });

  it('logs worker.cost_sync_gap with the uncovered minutes when failures outlast the catch-up window', async () => {
    const h = harness({ ...SETTINGS, catchUpMs: 180 * MIN });
    await h.loop.tick();
    h.advance(5 * MIN);
    h.state.failOn.add(h.state.calls + 1);
    const failed = await h.loop.tick();
    expect(failed).toEqual({ outcome: 'failed', retryFrom: minus(h.state.now, 120 * MIN) });
    // Four hours later: the retry point is 360 minutes back, the catch-up window 180.
    h.advance(240 * MIN);
    const pass = await h.loop.tick();
    expect(pass).toMatchObject({ outcome: 'synced', from: minus(h.state.now, 180 * MIN) });
    expect(h.logs.find((l) => l.event === 'worker.cost_sync_gap')).toEqual({
      level: 'warn',
      event: 'worker.cost_sync_gap',
      fields: { uncovered_minutes: 180 },
    });
  });

  it('a busy lock skips the pass without syncing and keeps the catch-up for the next pass', async () => {
    const h = harness();
    h.state.busy = true;
    await expect(h.loop.tick()).resolves.toEqual({ outcome: 'busy' });
    expect(h.state.calls).toBe(0);
    expect(h.logs).toEqual([{ level: 'info', event: 'worker.cost_sync_busy', fields: {} }]);
    h.state.busy = false;
    await expect(h.loop.tick()).resolves.toMatchObject({ from: minus(T0, 1440 * MIN) });
  });

  it('a database error never throws; the next pass still covers the missed window', async () => {
    const h = harness();
    await h.loop.tick();
    h.state.lockError = true;
    h.advance(5 * MIN);
    const missedFrom = minus(h.state.now, 120 * MIN);
    await expect(h.loop.tick()).resolves.toEqual({ outcome: 'failed', retryFrom: missedFrom });
    expect(h.logs.at(-1)).toEqual({
      level: 'error',
      event: 'worker.cost_sync_failed',
      fields: { error: 'unavailable' },
    });
    h.state.lockError = false;
    h.advance(180 * MIN);
    await expect(h.loop.tick()).resolves.toMatchObject({ outcome: 'synced', from: missedFrom });
  });

  it('logs codes and counts only, never an error text', async () => {
    const h = harness();
    h.state.failOn.add(1);
    await h.loop.tick();
    expect(JSON.stringify(h.logs)).not.toContain('LiteLLM text');
  });
});

describe('cost sync loop: the schedule', () => {
  it('runs a pass at start, then every interval after the previous pass ended; stop() ends it', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.logs.filter((l) => l.event === 'worker.cost_synced')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5 * MIN - 1);
    expect(h.logs.filter((l) => l.event === 'worker.cost_synced')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.logs.filter((l) => l.event === 'worker.cost_synced')).toHaveLength(2);
    await h.loop.stop();
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(h.logs.filter((l) => l.event === 'worker.cost_synced')).toHaveLength(2);
  });
});
