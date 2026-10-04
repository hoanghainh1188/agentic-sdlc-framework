// Gate waiting-time helpers (E06, ADR-M47): the default range (the last 30 days) and its limits,
// and the merge of finished waits (two rounds kept apart, QUESTIONS #205), platform passes and
// intents at the gate now (QUESTIONS #207) into one row per (project, gate).
import { describe, expect, it } from 'vitest';

import {
  GATE_METRICS_DEFAULT_DAYS,
  checkGateMetricsRange,
  mergeGateMetrics,
  resolveGateMetricsRange,
} from '../../packages/core/src/metrics/index.js';
import type { WaitStatsRow } from '../../packages/core/src/db/index.js';

const NOW = new Date('2026-10-04T09:30:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

describe('resolveGateMetricsRange', () => {
  it('defaults to the 30 days before now', () => {
    expect(GATE_METRICS_DEFAULT_DAYS).toBe(30);
    expect(resolveGateMetricsRange({}, NOW)).toEqual({
      from: new Date(NOW.getTime() - 30 * DAY),
      to: NOW,
    });
  });

  it('with only --to, the 30 days before it; with only --from, up to now', () => {
    const to = new Date('2026-09-01T00:00:00.000Z');
    expect(resolveGateMetricsRange({ to }, NOW)).toEqual({
      from: new Date('2026-08-02T00:00:00.000Z'),
      to,
    });
    const from = new Date('2026-07-01T00:00:00.000Z');
    expect(resolveGateMetricsRange({ from }, NOW)).toEqual({ from, to: NOW });
  });

  it('refuses an empty range and one longer than 366 days', () => {
    expect(checkGateMetricsRange({ from: NOW, to: NOW })).toBe('range_empty');
    expect(checkGateMetricsRange({ from: NOW, to: new Date(NOW.getTime() - 1) })).toBe(
      'range_empty',
    );
    const from = new Date(NOW.getTime() - 366 * DAY);
    expect(checkGateMetricsRange({ from, to: NOW })).toBeUndefined();
    expect(checkGateMetricsRange({ from: new Date(from.getTime() - 1), to: NOW })).toBe(
      'range_too_long',
    );
  });
});

const wait = (
  project: string,
  gate: WaitStatsRow['gate'],
  afterChanges: boolean,
  count: number,
): WaitStatsRow => ({
  project,
  gate,
  afterChanges,
  count,
  avgSeconds: 100 * count,
  maxSeconds: 200 * count,
  p50Seconds: 90 * count,
  p90Seconds: 190 * count,
});

describe('mergeGateMetrics', () => {
  it('one row per (project, gate), sorted by project then gate order, rounds kept apart', () => {
    const rows = mergeGateMetrics(
      {
        waits: [
          wait('shop', 'G3', false, 2),
          wait('shop', 'G3', true, 1),
          wait('ops', 'G1', false, 1),
        ],
        autoPasses: [{ project: 'shop', gate: 'G2', count: 4 }],
        open: [
          {
            project: 'shop',
            gate: 'G7',
            count: 2,
            oldestEnteredAt: new Date(NOW.getTime() - 3_725_500),
          },
        ],
      },
      NOW,
    );
    expect(rows.map((r) => `${r.project}/${r.gate}`)).toEqual([
      'ops/G1',
      'shop/G2',
      'shop/G3',
      'shop/G7',
    ]);
    const g3 = rows[2]!;
    expect(g3.firstRound).toEqual({
      count: 2,
      avgSeconds: 200,
      maxSeconds: 400,
      p50Seconds: 180,
      p90Seconds: 380,
    });
    expect(g3.afterChanges.count).toBe(1);
    expect(g3.autoPassed).toBe(0);
    expect(g3.open).toEqual({ count: 0, oldestSeconds: null });
    // A gate with only platform passes: no waits, never zero seconds.
    expect(rows[1]).toMatchObject({
      autoPassed: 4,
      firstRound: { count: 0, avgSeconds: null, maxSeconds: null, p50Seconds: null },
      afterChanges: { count: 0, p90Seconds: null },
    });
    // Open waits: whole seconds since the earliest entry, never mixed into the statistics.
    expect(rows[3]).toMatchObject({
      open: { count: 2, oldestSeconds: 3725 },
      firstRound: { count: 0 },
    });
  });

  it('sorts by gate order G1 … G8, whatever order the queries return', () => {
    const rows = mergeGateMetrics(
      {
        waits: [wait('a', 'G8', false, 1), wait('a', 'G1', false, 1), wait('a', 'G4', false, 1)],
        autoPasses: [],
        open: [],
      },
      NOW,
    );
    expect(rows.map((r) => r.gate)).toEqual(['G1', 'G4', 'G8']);
  });

  it('an entry time after now (clock skew) reads as 0 seconds, never negative', () => {
    const [row] = mergeGateMetrics(
      {
        waits: [],
        autoPasses: [],
        open: [
          { project: 'a', gate: 'G1', count: 1, oldestEnteredAt: new Date(NOW.getTime() + 5000) },
        ],
      },
      NOW,
    );
    expect(row!.open.oldestSeconds).toBe(0);
  });
});
