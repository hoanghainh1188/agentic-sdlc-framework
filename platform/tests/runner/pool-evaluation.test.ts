// The slot rule for evaluation runs (task L04, design/ADR-M81 §2.3, QUESTIONS #461): they use free
// slots only, at most `evalSize` at once, and a waiting real run takes a slot from a running
// evaluation run, which is stopped, marked `preempted` and queued again.
import { describe, expect, it } from 'vitest';

import { RunnerError, SlotPool } from '../../apps/runner/src/index.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('evaluation slots', () => {
  it('are off by default and cannot exceed the pool', async () => {
    const pool = new SlotPool(2);
    expect(pool.evalSize).toBe(0);
    await expect(pool.acquireEvaluation(() => undefined)).rejects.toBeInstanceOf(RunnerError);
    expect(() => new SlotPool(2, 3)).toThrow(RangeError);
    expect(() => new SlotPool(2, -1)).toThrow(RangeError);
  });

  it('use a free slot, and only while an evaluation slot is free', async () => {
    const pool = new SlotPool(3, 1);
    const first = await pool.acquireEvaluation(() => undefined);
    expect(pool.active).toBe(1);
    expect(pool.activeEvaluations).toBe(1);
    let second = false;
    void pool.acquireEvaluation(() => undefined).then(() => (second = true));
    await tick();
    // The pool has free slots, but evaluations are capped at one at the same time.
    expect(second).toBe(false);
    expect(pool.waitingEvaluations).toBe(1);
    first.release();
    await tick();
    expect(second).toBe(true);
    expect(pool.active).toBe(1);
  });

  it('never take the last slots from real runs: real runs still fill the pool', async () => {
    const pool = new SlotPool(2, 1);
    const evaluation = await pool.acquireEvaluation(() => undefined);
    const real = await pool.acquire();
    expect(pool.active).toBe(2);
    let third = false;
    void pool.acquire().then(() => (third = true));
    await tick();
    expect(third).toBe(false);
    real.release();
    await tick();
    expect(third).toBe(true);
    evaluation.release();
  });

  it('wait while the pool is full, and are served only when no real run waits', async () => {
    const pool = new SlotPool(1, 1);
    const real = await pool.acquire();
    const order: string[] = [];
    void pool
      .acquireEvaluation(() => undefined)
      .then((s) => {
        order.push('evaluation');
        s.release();
      });
    void pool.acquire().then((s) => {
      order.push('real');
      s.release();
    });
    await tick();
    expect(pool.waiting).toBe(1);
    expect(pool.waitingEvaluations).toBe(1);
    real.release();
    await tick();
    await tick();
    // The real run came second but is served first.
    expect(order).toEqual(['real', 'evaluation']);
    expect(pool.active).toBe(0);
  });

  it('are asked to stop when a real run waits and no slot is free, once, newest first', async () => {
    const pool = new SlotPool(2, 2);
    const asked: string[] = [];
    const older = await pool.acquireEvaluation(() => asked.push('older'));
    const newer = await pool.acquireEvaluation(() => asked.push('newer'));
    let real = false;
    void pool.acquire().then(() => (real = true));
    await tick();
    expect(asked).toEqual(['newer']);
    expect(real).toBe(false);
    // The stopped run releases its slot: the real run gets it, the other evaluation keeps running.
    newer.release();
    await tick();
    expect(real).toBe(true);
    expect(asked).toEqual(['newer']);
    expect(pool.activeEvaluations).toBe(1);
    older.release();
  });

  it('are asked once per waiting real run, never twice for the same one', async () => {
    const pool = new SlotPool(2, 2);
    const asked: string[] = [];
    const a = await pool.acquireEvaluation(() => asked.push('a'));
    const b = await pool.acquireEvaluation(() => asked.push('b'));
    void pool.acquire();
    await tick();
    expect(asked).toEqual(['b']);
    void pool.acquire();
    await tick();
    expect(asked).toEqual(['b', 'a']);
    a.release();
    b.release();
  });

  it('are not asked to stop when the pool has a free slot or only real runs hold it', async () => {
    const pool = new SlotPool(2, 1);
    let asked = 0;
    const evaluation = await pool.acquireEvaluation(() => (asked += 1));
    const real = await pool.acquire();
    expect(asked).toBe(0);
    void pool.acquire();
    await tick();
    expect(asked).toBe(1);
    real.release();
    evaluation.release();

    const full = new SlotPool(1, 1);
    const holder = await full.acquire();
    void full.acquire();
    await tick();
    expect(full.activeEvaluations).toBe(0);
    holder.release();
  });

  it('survive a callback that throws, and an aborted wait leaves the queue', async () => {
    const pool = new SlotPool(1, 1);
    const evaluation = await pool.acquireEvaluation(() => {
      throw new Error('boom');
    });
    let real = false;
    void pool.acquire().then(() => (real = true));
    await tick();
    evaluation.release();
    await tick();
    expect(real).toBe(true);

    const controller = new AbortController();
    const waiting = pool.acquireEvaluation(() => undefined, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toBeInstanceOf(RunnerError);
    expect(pool.waitingEvaluations).toBe(0);
  });

  it('release is safe to call twice', async () => {
    const pool = new SlotPool(2, 1);
    const slot = await pool.acquireEvaluation(() => undefined);
    slot.release();
    slot.release();
    expect(pool.active).toBe(0);
    expect(pool.activeEvaluations).toBe(0);
  });
});
