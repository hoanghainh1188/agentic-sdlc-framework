import { describe, expect, it } from '@jest/globals';
import { formatOrderNumber } from './order-rules.js';

describe('formatOrderNumber (hidden)', () => {
  it('pads to six digits', () => {
    expect(formatOrderNumber(1)).toBe('SO-000001');
    expect(formatOrderNumber(42)).toBe('SO-000042');
    expect(formatOrderNumber(999999)).toBe('SO-999999');
  });

  it('never cuts a longer value', () => {
    expect(formatOrderNumber(1234567)).toBe('SO-1234567');
  });
});
