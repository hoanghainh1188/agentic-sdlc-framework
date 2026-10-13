import { describe, expect, it } from '@jest/globals';
import { findShortages } from './stock-rules.js';

describe('findShortages (hidden)', () => {
  it('accepts a request equal to the available stock', () => {
    expect(findShortages([{ productId: 1, quantity: 5 }], new Map([[1, 5]]))).toEqual([]);
  });

  it('still reports a request above the available stock', () => {
    expect(findShortages([{ productId: 1, quantity: 6 }], new Map([[1, 5]]))).toEqual([
      { productId: 1, requested: 6, available: 5 },
    ]);
  });

  it('adds up lines of the same product before the check', () => {
    expect(
      findShortages(
        [
          { productId: 2, quantity: 2 },
          { productId: 2, quantity: 3 },
        ],
        new Map([[2, 5]]),
      ),
    ).toEqual([]);
  });
});
