// Runs a test body with the wall clock (`new Date()`, `Date.now()`) moved to another day, to
// prove that a test does not depend on the real date: tests use a fixed test clock (T0 …), and
// only code that rightly reads the real clock may see this one. Only `Date` is faked; timers and
// the database driver keep running, and the faked clock keeps advancing with real time.
import { vi } from 'vitest';

/** A day far after every fixed test clock (T0 2026-09-28): the real date in some months. */
export const LATER_WALL_CLOCK = new Date('2027-06-01T03:00:00.000Z');

export async function withWallClock<T>(at: Date | null, body: () => Promise<T>): Promise<T> {
  if (at === null) return await body();
  vi.useFakeTimers({ toFake: ['Date'], now: at, shouldAdvanceTime: true });
  try {
    return await body();
  } finally {
    vi.useRealTimers();
  }
}
