import { describe, expect, it } from '@jest/globals';
import { resolvePaging } from './paging.js';

describe('resolvePaging (hidden)', () => {
  it('uses the defaults', () => {
    expect(resolvePaging({})).toEqual({ page: 1, pageSize: 20, offset: 0 });
  });

  it('computes the offset', () => {
    expect(resolvePaging({ page: 3, pageSize: 25 })).toEqual({ page: 3, pageSize: 25, offset: 50 });
  });

  it('accepts the edge sizes', () => {
    expect(resolvePaging({ pageSize: 1 }).pageSize).toBe(1);
    expect(resolvePaging({ pageSize: 100 }).pageSize).toBe(100);
  });

  it.each([
    { pageSize: 101 },
    { pageSize: 0 },
    { page: 0 },
    { page: 1.5 },
    { pageSize: 2.5 },
    { page: -1 },
  ])('refuses %j', (input) => {
    expect(() => resolvePaging(input)).toThrow(RangeError);
  });
});
