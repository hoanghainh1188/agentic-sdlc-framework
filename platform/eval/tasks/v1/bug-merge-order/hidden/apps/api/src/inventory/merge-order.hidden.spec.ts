import { describe, expect, it } from '@jest/globals';
import { mergeRequests } from './stock-rules.js';

describe('mergeRequests (hidden)', () => {
  it('sorts the merged requests by product id', () => {
    expect(
      mergeRequests([
        { productId: 9, quantity: 1 },
        { productId: 3, quantity: 2 },
        { productId: 7, quantity: 1 },
        { productId: 3, quantity: 4 },
      ]),
    ).toEqual([
      { productId: 3, quantity: 6 },
      { productId: 7, quantity: 1 },
      { productId: 9, quantity: 1 },
    ]);
  });

  it('returns an empty list for no requests', () => {
    expect(mergeRequests([])).toEqual([]);
  });
});
