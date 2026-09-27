// A fixed-window counter per key, in memory (task B03, ADR-M26 section 2.7). Enough for one api
// instance on the internal server; a shared limiter (Valkey) comes when there is more than one.
export class RateLimiter {
  readonly #windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts one hit for `key`. False when the key is over its limit in the current window. */
  hit(key: string): boolean {
    const now = this.now();
    const window = this.#windows.get(key);
    if (!window || now - window.start >= this.windowMs) {
      this.#sweep(now);
      this.#windows.set(key, { start: now, count: 1 });
      return true;
    }
    window.count += 1;
    return window.count <= this.limit;
  }

  /** True when `key` is already over its limit, without counting a hit. */
  blocked(key: string): boolean {
    const window = this.#windows.get(key);
    return !!window && this.now() - window.start < this.windowMs && window.count >= this.limit;
  }

  #sweep(now: number): void {
    for (const [key, window] of this.#windows) {
      if (now - window.start >= this.windowMs) this.#windows.delete(key);
    }
  }
}
