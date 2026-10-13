import { describe, expect, it } from '@jest/globals';
import { calculateTax } from './tax-rules.js';

describe('calculateTax (hidden)', () => {
  it('standard rate, rounded down', () => {
    expect(calculateTax([{ amount: 1001, category: 'standard' }])).toEqual({
      beforeTax: 1001,
      tax: 100,
      includingTax: 1101,
    });
  });

  it('reduced rate, rounded down', () => {
    expect(calculateTax([{ amount: 999, category: 'reduced' }])).toEqual({
      beforeTax: 999,
      tax: 79,
      includingTax: 1078,
    });
  });

  it('adds up per rate before rounding', () => {
    expect(
      calculateTax([
        { amount: 105, category: 'standard' },
        { amount: 105, category: 'standard' },
      ]),
    ).toEqual({ beforeTax: 210, tax: 21, includingTax: 231 });
  });

  it('mixes the two rates', () => {
    expect(
      calculateTax([
        { amount: 1001, category: 'standard' },
        { amount: 999, category: 'reduced' },
      ]),
    ).toEqual({ beforeTax: 2000, tax: 179, includingTax: 2179 });
  });

  it('an empty order has no tax', () => {
    expect(calculateTax([])).toEqual({ beforeTax: 0, tax: 0, includingTax: 0 });
  });
});
