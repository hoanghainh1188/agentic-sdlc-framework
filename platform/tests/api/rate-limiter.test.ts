import { describe, expect, it } from 'vitest';

import { RateLimiter } from '../../apps/api/src/auth/rate-limiter.js';

describe('RateLimiter', () => {
  it('allows `limit` hits per window and key, then refuses until the window ends', () => {
    let now = 0;
    const limiter = new RateLimiter(2, 60_000, () => now);
    expect([limiter.hit('a'), limiter.hit('a'), limiter.hit('a')]).toEqual([true, true, false]);
    expect(limiter.blocked('a')).toBe(true);
    expect(limiter.hit('b')).toBe(true);
    now = 60_000;
    expect(limiter.blocked('a')).toBe(false);
    expect(limiter.hit('a')).toBe(true);
  });

  it('forgets expired keys', () => {
    let now = 0;
    const limiter = new RateLimiter(1, 1000, () => now);
    limiter.hit('a');
    limiter.hit('a');
    expect(limiter.blocked('a')).toBe(true);
    now = 5000;
    limiter.hit('b');
    expect(limiter.blocked('a')).toBe(false);
    expect(limiter.hit('a')).toBe(true);
  });
});
