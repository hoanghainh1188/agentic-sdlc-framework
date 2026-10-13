import { describe, expect, it } from '@jest/globals';
import { isLowStock } from './stock-rules.js';

describe('isLowStock (hidden)', () => {
  it('is low at or below the threshold', () => {
    expect(isLowStock(10, 10)).toBe(true);
    expect(isLowStock(3, 10)).toBe(true);
    expect(isLowStock(11, 10)).toBe(false);
  });

  it('with threshold 0, is low only at 0', () => {
    expect(isLowStock(0, 0)).toBe(true);
    expect(isLowStock(1, 0)).toBe(false);
  });
});
