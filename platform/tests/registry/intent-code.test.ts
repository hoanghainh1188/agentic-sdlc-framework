// D-02 FR-01, ADR-M20: intent codes INT-YYYY-NNNN, year from the UTC clock.
import { describe, expect, it } from 'vitest';

import {
  formatIntentCode,
  intentCodeYear,
  parseIntentCode,
} from '../../packages/core/src/registry/intent-code.js';

describe('intent codes', () => {
  it('pads the number to four digits and grows past 9999', () => {
    expect(formatIntentCode(2026, 1)).toBe('INT-2026-0001');
    expect(formatIntentCode(2026, 9999)).toBe('INT-2026-9999');
    expect(formatIntentCode(2026, 10_000)).toBe('INT-2026-10000');
  });

  it('parses its own output and refuses anything else', () => {
    expect(parseIntentCode('INT-2026-0042')).toEqual({ year: 2026, number: 42 });
    expect(parseIntentCode('INT-2026-10000')).toEqual({ year: 2026, number: 10_000 });
    for (const bad of ['INT-26-0001', 'INT-2026-001', 'int-2026-0001', 'INT-2026-0001 ', 'X']) {
      expect(parseIntentCode(bad), bad).toBeUndefined();
    }
  });

  it('refuses numbers and years out of range', () => {
    expect(() => formatIntentCode(2026, 0)).toThrow(RangeError);
    expect(() => formatIntentCode(2026, 1.5)).toThrow(RangeError);
    expect(() => formatIntentCode(2026, 1_000_000_000)).toThrow(RangeError);
    expect(() => formatIntentCode(999, 1)).toThrow(RangeError);
  });

  it('takes the year from UTC, not from the local time zone (D-05 D5)', () => {
    // 2027-01-01 06:30 in Vietnam (UTC+7) is still 2026 in UTC.
    expect(intentCodeYear(new Date('2026-12-31T23:30:00.000Z'))).toBe(2026);
    expect(intentCodeYear(new Date('2027-01-01T00:00:00.000Z'))).toBe(2027);
  });
});
