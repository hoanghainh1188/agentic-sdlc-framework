// D-08 C04 AC1 (egress plan) and AC3 (concurrent sandboxes, queue), ADR-M25 §2.2 and §2.7.
import { describe, expect, it } from 'vitest';

import { planEgress, RunnerError, SlotPool } from '../../apps/runner/src/index.js';
import { settings } from './helpers';

const services = settings().egressServices;

describe('egress plan (D-03 §9 v1.6)', () => {
  it('maps the allowlist to the configured services', () => {
    expect(planEgress(['litellm:4000', 'npm-proxy:4873'], services)).toEqual({
      ok: true,
      services,
    });
    expect(planEgress(['litellm:4000'], services)).toEqual({ ok: true, services: [services[0]] });
    expect(planEgress([], services)).toEqual({ ok: true, services: [] });
  });

  it.each([
    ['github.com'],
    ['api.github.com:443'],
    ['litellm:4001'],
    ['openbao:8200'],
    ['LITELLM:4000'],
  ])('refuses %s: the runner cannot enforce it, so the run does not start', (entry) => {
    expect(planEgress(['litellm:4000', entry], services)).toEqual({
      ok: false,
      reason: 'egress_not_enforceable',
    });
  });
});

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('slot pool (AC3)', () => {
  it('never runs more than the limit; extra runs wait in arrival order', async () => {
    const pool = new SlotPool(2);
    const order: string[] = [];
    const a = await pool.acquire();
    const b = await pool.acquire();
    const c = pool.acquire().then((slot) => (order.push('c'), slot));
    const d = pool.acquire().then((slot) => (order.push('d'), slot));
    await tick();
    expect([pool.active, pool.waiting, order]).toEqual([2, 2, []]);
    b.release();
    const slotC = await c;
    expect([pool.active, pool.waiting, order]).toEqual([2, 1, ['c']]);
    a.release();
    a.release(); // a second release is ignored
    await d;
    expect([pool.active, pool.waiting, order]).toEqual([2, 0, ['c', 'd']]);
    slotC.release();
    expect(pool.active).toBe(1);
  });

  it('frees the slot when the work fails', async () => {
    const pool = new SlotPool(1);
    await expect(pool.withSlot(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(pool.active).toBe(0);
    await expect(pool.withSlot(() => Promise.resolve(7))).resolves.toBe(7);
  });

  it('an aborted wait leaves the queue without taking a slot', async () => {
    const pool = new SlotPool(1);
    const held = await pool.acquire();
    const controller = new AbortController();
    const waiting = pool.acquire(controller.signal);
    controller.abort();
    await expect(waiting).rejects.toBeInstanceOf(RunnerError);
    expect(pool.waiting).toBe(0);
    held.release();
    expect(pool.active).toBe(0);
  });

  it('with the default limit of 1, a second run waits until the first ends', async () => {
    const pool = new SlotPool(settings().maxSandboxes);
    let release!: () => void;
    const first = pool.withSlot(() => new Promise<void>((r) => (release = r)));
    let secondStarted = false;
    const second = pool.withSlot(() => {
      secondStarted = true;
      return Promise.resolve();
    });
    await tick();
    expect(secondStarted).toBe(false);
    release();
    await Promise.all([first, second]);
    expect(secondStarted).toBe(true);
  });
});
