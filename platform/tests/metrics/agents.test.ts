// Agent efficiency report helpers (V13, ADR-M79): the cache share rounds half up to one decimal,
// and the merge turns the grouped query rows into one row per (project, agent version, model)
// with measures that stay null without data and never mix runs still in progress into a rate.
import { describe, expect, it } from 'vitest';

import {
  cacheShare,
  checkAgentMetricsRange,
  mergeAgentMetrics,
  resolveAgentMetricsRange,
} from '../../packages/core/src/metrics/index.js';

const NOW = new Date('2026-10-04T09:30:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

const key = (model: string, project = 'shop') => ({
  project,
  agentKey: 'coder',
  agentVersion: '1.4.0',
  model,
});
const count = (model: string, status: string, n: number, extra = {}) => ({
  ...key(model),
  status: status as 'succeeded',
  stopReason: null,
  retry: false,
  count: n,
  ...extra,
});
const NONE = { counts: [], costs: [], ci: [], merged: [], breaches: [] };

describe('cacheShare', () => {
  it.each([
    ['0', '0', null],
    ['0', '1000', 0],
    ['100', '1450', 6.9],
    ['1', '3', 33.3],
    ['2', '3', 66.7],
    ['5', '5', 100],
  ])('%s of %s input tokens → %j percent', (cached, input, percent) => {
    expect(cacheShare(cached, input)).toBe(percent);
  });

  it('is exact for token sums beyond 2^53', () => {
    expect(cacheShare('9007199254740993', '18014398509481986')).toBe(50);
  });
});

describe('the range is the gate metrics range (30 days by default, at most 366)', () => {
  it('defaults to the 30 days before now', () => {
    expect(resolveAgentMetricsRange({}, NOW)).toEqual({
      from: new Date(NOW.getTime() - 30 * DAY),
      to: NOW,
    });
  });

  it('refuses an empty range and one longer than 366 days', () => {
    expect(checkAgentMetricsRange({ from: NOW, to: NOW })).toBe('range_empty');
    expect(checkAgentMetricsRange({ from: new Date(NOW.getTime() - 367 * DAY), to: NOW })).toBe(
      'range_too_long',
    );
    expect(
      checkAgentMetricsRange({ from: new Date(NOW.getTime() - 366 * DAY), to: NOW }),
    ).toBeUndefined();
  });
});

describe('mergeAgentMetrics', () => {
  it('makes no row without runs', () => {
    expect(
      mergeAgentMetrics({
        ...NONE,
        ci: [{ ...key('m'), total: 1, passed: 1 }],
        breaches: [{ ...key('m'), count: 2 }],
      }),
    ).toEqual([]);
  });

  it('counts statuses, stop reasons and retries, and sets runs in progress apart', () => {
    const [row] = mergeAgentMetrics({
      ...NONE,
      counts: [
        count('m', 'succeeded', 2),
        count('m', 'failed', 1, { stopReason: 'agent_error', retry: true }),
        count('m', 'running', 1),
        count('m', 'stopping', 1),
      ],
    });
    expect(row!.runs).toEqual({
      total: 5,
      inProgress: 2,
      byStatus: { succeeded: 2, failed: 1, running: 1, stopping: 1 },
      byStopReason: { agent_error: 1 },
      retries: 1,
    });
  });

  it('keeps measures without data null, never 0', () => {
    const [row] = mergeAgentMetrics({ ...NONE, counts: [count('unknown', 'queued', 1)] });
    expect(row!.merged.leadTime).toEqual({ count: 0, avgSeconds: null, maxSeconds: null });
    expect(row!.tokens.cacheSharePercent).toBeNull();
    expect(row!.cost).toEqual({
      totalUsd: '0.000000',
      wastedUsd: '0.000000',
      perRunUsd: '0.000000',
      perMergedIntentUsd: null,
    });
  });

  it('divides money exactly in micros: per run and per merged intent', () => {
    const [row] = mergeAgentMetrics({
      ...NONE,
      counts: [count('m', 'succeeded', 3)],
      costs: [
        {
          ...key('m'),
          inputTokens: '10',
          outputTokens: '5',
          cachedInputTokens: '0',
          costUsd: '0.1',
          wastedCostUsd: '0.000001',
        },
      ],
      merged: [
        {
          ...key('m'),
          merged: 3,
          withoutChanges: 1,
          costUsd: '1',
          leadTimeCount: 2,
          leadTimeSumSeconds: '301',
          leadTimeMaxSeconds: 300,
        },
      ],
    });
    // 0.1 / 3 = 0.033333 (micros, rounded down); 1 / 3 = 0.333333.
    expect(row!.cost).toEqual({
      totalUsd: '0.100000',
      wastedUsd: '0.000001',
      perRunUsd: '0.033333',
      perMergedIntentUsd: '0.333333',
    });
    expect(row!.merged).toEqual({
      intents: 3,
      withoutChangesRequested: 1,
      leadTime: { count: 2, avgSeconds: 150, maxSeconds: 300 },
    });
  });

  it('sorts by project, agent, version (numeric) and model', () => {
    const rows = mergeAgentMetrics({
      ...NONE,
      counts: [
        count('b', 'succeeded', 1),
        { ...count('a', 'succeeded', 1), agentVersion: '1.10.0' },
        { ...count('a', 'succeeded', 1), agentVersion: '1.9.0' },
        { ...count('z', 'succeeded', 1), project: 'ops' },
      ],
    });
    expect(rows.map((r) => [r.project, r.agentVersion, r.model])).toEqual([
      ['ops', '1.4.0', 'z'],
      ['shop', '1.4.0', 'b'],
      ['shop', '1.9.0', 'a'],
      ['shop', '1.10.0', 'a'],
    ]);
  });
});
