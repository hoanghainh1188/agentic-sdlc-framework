// Cost Controller helpers (D-08 C03, ADR-M24): USD as decimal strings, never floats (D-05 D6),
// the UTC calendar month of the tenant budget, and a catalog message per error code (NFR-08).
import { t } from '@sdlc/messages';
import { describe, expect, it } from 'vitest';

import {
  COST_ERROR_CODES,
  COST_ERROR_MESSAGES,
  fromMicros,
  isUsd,
  startOfUtcMonth,
  toMicros,
} from '../../packages/core/src/cost/index.js';

describe('USD amounts', () => {
  it('parses our strings and PostgreSQL numeric text into micro-dollars', () => {
    expect(toMicros('2')).toBe(2_000_000n);
    expect(toMicros('0.0012')).toBe(1_200n);
    expect(toMicros('100.000000')).toBe(100_000_000n);
    expect(toMicros('-0.5')).toBe(-500_000n);
  });

  it('formats micro-dollars as the shortest decimal string', () => {
    expect(fromMicros(1_200n)).toBe('0.0012');
    expect(fromMicros(2_000_000n)).toBe('2');
    expect(fromMicros(0n)).toBe('0');
    expect(fromMicros(-500_000n)).toBe('-0.5');
  });

  it('never goes through floating point: 0.1 + 0.2 is exactly 0.3', () => {
    expect(fromMicros(toMicros('0.1') + toMicros('0.2'))).toBe('0.3');
  });

  it('refuses more than 6 decimals, exponents and text', () => {
    for (const bad of ['0.0000001', '1e-3', 'abc', '', ' 1']) {
      expect(() => toMicros(bad), bad).toThrow(RangeError);
    }
    expect(isUsd('0.5')).toBe(true);
    expect(isUsd('-1')).toBe(false);
    expect(isUsd('01')).toBe(false);
    expect(isUsd(0.5)).toBe(false);
  });
});

describe('tenant budget month', () => {
  it('starts at 00:00 UTC on the first day of the UTC month', () => {
    expect(startOfUtcMonth(new Date('2026-09-26T08:00:00Z')).toISOString()).toBe(
      '2026-09-01T00:00:00.000Z',
    );
    // 2026-10-01 01:00 in Tokyo is still September in UTC.
    expect(startOfUtcMonth(new Date('2026-10-01T01:00:00+09:00')).toISOString()).toBe(
      '2026-09-01T00:00:00.000Z',
    );
  });
});

describe('error messages', () => {
  it('every error code has a catalog message', () => {
    expect(Object.keys(COST_ERROR_MESSAGES).sort()).toEqual([...COST_ERROR_CODES].sort());
    for (const code of COST_ERROR_CODES) expect(t(COST_ERROR_MESSAGES[code])).not.toBe('');
    expect(t(COST_ERROR_MESSAGES.invalid_label, { field: 'agent' })).toContain('agent');
  });
});
