// C11 PR 2 (D-02 FR-35, design/ADR-M42 §2.7): the runner's loop watch with a fake clock. More
// identical tool calls in a row than the threshold → `loop_detected`; no new agent event for the
// window → `no_progress`. Counts only.
import { describe, expect, it } from 'vitest';

import { LoopWatch } from '../../apps/runner/src/index.js';

const MINUTE = 60_000;

function watch(identicalCallsMax = 3, windowMinutes = 15) {
  let now = 1_000_000;
  const w = new LoopWatch(
    { identicalCallsMax, noProgressWindowMs: windowMinutes * MINUTE },
    () => now,
  );
  return {
    w,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('LoopWatch: identical tool calls', () => {
  it('stops only at more than the threshold (3 is fine, 4 stops)', () => {
    const { w } = watch(3);
    expect(w.observe({ events: 1, identicalCalls: 3 })).toBeUndefined();
    expect(w.observe({ events: 2, identicalCalls: 4 })).toEqual({
      reason: 'loop_detected',
      identical_calls: 4,
      threshold: 3,
      idle_minutes: 0,
    });
  });

  it('uses the threshold it was given (the contract)', () => {
    const { w } = watch(1);
    expect(w.observe({ events: 1, identicalCalls: 1 })).toBeUndefined();
    expect(w.observe({ events: 2, identicalCalls: 2 })?.reason).toBe('loop_detected');
  });

  it('reports identical calls before no progress when both are due', () => {
    const { w, advance } = watch(3, 15);
    w.observe({ events: 5, identicalCalls: 0 });
    advance(15 * MINUTE);
    expect(w.observe({ events: 5, identicalCalls: 4 })).toMatchObject({
      reason: 'loop_detected',
      idle_minutes: 15,
    });
  });
});

describe('LoopWatch: no progress', () => {
  it('stops when the log has not grown for the whole window, not one millisecond earlier', () => {
    const { w, advance } = watch(3, 15);
    expect(w.observe({ events: 7, identicalCalls: 1 })).toBeUndefined();
    advance(15 * MINUTE - 1);
    expect(w.observe({ events: 7, identicalCalls: 1 })).toBeUndefined();
    advance(1);
    expect(w.observe({ events: 7, identicalCalls: 1 })).toEqual({
      reason: 'no_progress',
      identical_calls: 1,
      threshold: 3,
      idle_minutes: 15,
    });
  });

  it('a new event of any kind restarts the window', () => {
    const { w, advance } = watch(3, 15);
    w.observe({ events: 7, identicalCalls: 0 });
    advance(14 * MINUTE);
    expect(w.observe({ events: 8, identicalCalls: 0 })).toBeUndefined();
    advance(14 * MINUTE);
    expect(w.observe({ events: 8, identicalCalls: 0 })).toBeUndefined();
    advance(MINUTE);
    expect(w.observe({ events: 8, identicalCalls: 0 })?.reason).toBe('no_progress');
  });

  it('the window starts when the watch starts (an agent that never produces an event)', () => {
    const { w, advance } = watch(3, 5);
    advance(5 * MINUTE);
    expect(w.observe({ events: 0, identicalCalls: 0 })).toBeUndefined();
    advance(5 * MINUTE);
    expect(w.observe({ events: 0, identicalCalls: 0 })?.reason).toBe('no_progress');
  });
});
