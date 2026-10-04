// Cost report helpers (E04, ADR-M45): the half-open UTC range and its limits, the default range and
// grouping, the wasted and in-progress status lists (QUESTIONS #195), and the formatting of sums:
// money as a decimal string with 6 decimals, tokens as digit strings, never a float (D-05 D6).
import { RUN_STATUSES } from '@sdlc/contracts';
import {
  COST_REPORT_MAX_DAYS,
  IN_PROGRESS_RUN_STATUSES,
  WASTED_RUN_STATUSES,
  checkCostReportRange,
  defaultCostReportGroup,
  formatUsd6,
  parseCostReportTime,
  resolveCostReportRange,
  toCostAmounts,
} from '../../packages/core/src/cost/index.js';
import { describe, expect, it } from 'vitest';

const NOW = new Date('2026-10-04T09:30:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

describe('parseCostReportTime', () => {
  it('reads a date as 00:00 UTC and a UTC time as given', () => {
    expect(parseCostReportTime('2026-10-01')?.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(parseCostReportTime('2026-10-01T12:34:56Z')?.toISOString()).toBe(
      '2026-10-01T12:34:56.000Z',
    );
    expect(parseCostReportTime('2026-10-01T12:34:56.789Z')?.toISOString()).toBe(
      '2026-10-01T12:34:56.789Z',
    );
  });

  it.each([
    '2026-10-01T12:34:56+09:00',
    '2026-10-01T12:34:56',
    '2026-02-30',
    '2026-13-01',
    '1696118400',
    'yesterday',
    '',
  ])('refuses %j (local times, offsets, dates that do not exist)', (value) => {
    expect(parseCostReportTime(value)).toBeUndefined();
  });
});

describe('the range', () => {
  it('defaults to the start of the current UTC month until now', () => {
    expect(resolveCostReportRange({}, NOW)).toEqual({
      from: new Date('2026-10-01T00:00:00.000Z'),
      to: NOW,
    });
  });

  it('with only --to, starts at the month of the last instant before it', () => {
    const to = new Date('2026-09-01T00:00:00.000Z');
    expect(resolveCostReportRange({ to }, NOW).from.toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  it('with only --from, ends now', () => {
    const from = new Date('2026-09-15T00:00:00.000Z');
    expect(resolveCostReportRange({ from }, NOW)).toEqual({ from, to: NOW });
  });

  it('refuses an empty or reversed range, and more than 366 days', () => {
    const from = new Date('2026-01-01T00:00:00.000Z');
    expect(checkCostReportRange({ from, to: from })).toBe('range_empty');
    expect(checkCostReportRange({ from, to: new Date(from.getTime() - 1) })).toBe('range_empty');
    const longest = new Date(from.getTime() + COST_REPORT_MAX_DAYS * DAY);
    expect(checkCostReportRange({ from, to: longest })).toBeUndefined();
    expect(checkCostReportRange({ from, to: new Date(longest.getTime() + 1) })).toBe(
      'range_too_long',
    );
  });
});

describe('the run status lists (QUESTIONS #195)', () => {
  it('wasted = failed, cancelled, stopped_*; in progress = not final yet', () => {
    expect([...WASTED_RUN_STATUSES].sort()).toEqual(
      RUN_STATUSES.filter(
        (s) => s === 'failed' || s === 'cancelled' || s.startsWith('stopped_'),
      ).sort(),
    );
    expect([...IN_PROGRESS_RUN_STATUSES].sort()).toEqual(
      ['provisioning', 'queued', 'running', 'stopping'].sort(),
    );
  });

  it('every run status is wasted, in progress or a success, never two of them', () => {
    const successes = ['succeeded', 'succeeded_proposal_only'];
    const all = [...WASTED_RUN_STATUSES, ...IN_PROGRESS_RUN_STATUSES, ...successes];
    expect(all.sort()).toEqual([...RUN_STATUSES].sort());
  });
});

describe('grouping', () => {
  it('defaults to one level below the scope', () => {
    expect(defaultCostReportGroup('tenant')).toBe('project');
    expect(defaultCostReportGroup('project')).toBe('intent');
    expect(defaultCostReportGroup('intent')).toBe('model');
  });
});

describe('formatting of sums', () => {
  it('money: exactly 6 decimals, from what PostgreSQL returns', () => {
    expect(formatUsd6('0')).toBe('0.000000');
    expect(formatUsd6('0.3')).toBe('0.300000');
    expect(formatUsd6('0.300000')).toBe('0.300000');
    expect(formatUsd6('123456789012.000001')).toBe('123456789012.000001');
    expect(() => formatUsd6('-1')).toThrow(RangeError);
    expect(() => formatUsd6('0.1234567')).toThrow(RangeError);
  });

  it('tokens stay digit strings, also beyond 2^53', () => {
    const big = '90071992547409930';
    const amounts = toCostAmounts({
      calls: '2',
      input_tokens: big,
      output_tokens: '0',
      cached_input_tokens: '007',
      cost_usd: '1.5',
      wasted_tokens: '0',
      wasted_cost_usd: '0',
    });
    expect(amounts).toEqual({
      calls: 2,
      inputTokens: big,
      outputTokens: '0',
      cachedInputTokens: '7',
      costUsd: '1.500000',
      wastedTokens: '0',
      wastedCostUsd: '0.000000',
    });
  });

  it('refuses a token sum with a fraction', () => {
    expect(() =>
      toCostAmounts({
        calls: '1',
        input_tokens: '1.5',
        output_tokens: '0',
        cached_input_tokens: '0',
        cost_usd: '0',
        wasted_tokens: '0',
        wasted_cost_usd: '0',
      }),
    ).toThrow(RangeError);
  });
});
