// B07 (ADR-M30 §2.3): the reconcile loop wakes every open intent, page by page, keeps going when a
// signal fails, and logs IDs and counts only. With Temporal: tests/integration/workflow.
import { describe, expect, it, vi } from 'vitest';

import { ReconcileLoop } from '../../apps/worker/src/reconcile-loop.js';
import type { IntentWorkflowRef } from '../../packages/contracts/src/intent-workflow.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const intent = (n: number): IntentWorkflowRef => ({
  tenantId: TENANT,
  intentId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
});

function harness(count: number, failing: ReadonlySet<number> = new Set()) {
  const all = Array.from({ length: count }, (_, i) => intent(i + 1));
  const woken: string[] = [];
  const pages: (string | undefined)[] = [];
  const logs: { event: string; fields: Record<string, unknown> }[] = [];
  const loop = new ReconcileLoop({
    listOpen: (limit, after) => {
      pages.push(after?.intentId);
      const start = after ? all.findIndex((i) => i.intentId === after.intentId) + 1 : 0;
      return Promise.resolve(all.slice(start, start + limit));
    },
    signals: {
      wake: (ref) => {
        const n = all.indexOf(all.find((i) => i.intentId === ref.intentId)!) + 1;
        if (failing.has(n)) return Promise.reject(new Error('temporal down'));
        woken.push(ref.intentId);
        return Promise.resolve();
      },
      kill: () => Promise.resolve(),
    },
    logger: { log: (_level, event, fields) => logs.push({ event, fields: { ...fields } }) },
    batchSize: 2,
  });
  return { loop, all, woken, pages, logs };
}

describe('B07: reconcile loop', () => {
  it('wakes every open intent, in keyset pages', async () => {
    const h = harness(5);
    expect(await h.loop.pass()).toEqual({ woken: 5, failed: 0 });
    expect(h.woken).toEqual(h.all.map((i) => i.intentId));
    // Pages of 2: after nothing, after #2, after #4 (the last page is short).
    expect(h.pages).toEqual([undefined, h.all[1]!.intentId, h.all[3]!.intentId]);
    expect(h.logs.at(-1)).toEqual({ event: 'worker.reconciled', fields: { woken: 5, failed: 0 } });
  });

  it('a failed signal skips only that intent and logs IDs only', async () => {
    const h = harness(3, new Set([2]));
    expect(await h.loop.pass()).toEqual({ woken: 2, failed: 1 });
    expect(h.logs[0]).toEqual({
      event: 'worker.wake_failed',
      fields: { tenant_id: TENANT, intent_id: h.all[1]!.intentId },
    });
    expect(JSON.stringify(h.logs)).not.toContain('temporal down');
  });

  it('an empty page ends the pass', async () => {
    const h = harness(0);
    expect(await h.loop.pass()).toEqual({ woken: 0, failed: 0 });
    expect(h.pages).toEqual([undefined]);
  });

  it('start runs a pass at once; stop ends the loop', async () => {
    const h = harness(2);
    h.loop.start(60_000);
    await vi.waitFor(() => expect(h.woken).toHaveLength(2));
    await h.loop.stop();
  });

  it('stop ends a pass early: nothing is woken after it', async () => {
    const h = harness(4);
    h.loop.start(60_000);
    await h.loop.stop();
    expect(h.woken).toEqual([]);
  });
});

describe('C11: the reconcile loop sends the kill signal again', () => {
  it('signals the intents whose current run is being killed, after the wakes', async () => {
    const order: string[] = [];
    const logs: { event: string; fields: Record<string, unknown> }[] = [];
    const killing = [intent(1), intent(2)];
    const loop = new ReconcileLoop({
      listOpen: () => Promise.resolve([intent(1)]),
      listKilling: (limit) => {
        expect(limit).toBe(10);
        return Promise.resolve(killing);
      },
      signals: {
        wake: (ref) => {
          order.push(`wake:${ref.intentId.slice(-1)}`);
          return Promise.resolve();
        },
        kill: (ref) => {
          if (ref.intentId === killing[1]!.intentId) return Promise.reject(new Error('down'));
          order.push(`kill:${ref.intentId.slice(-1)}`);
          return Promise.resolve();
        },
      },
      logger: { log: (_level, event, fields) => logs.push({ event, fields: { ...fields } }) },
      batchSize: 10,
    });
    expect(await loop.pass()).toEqual({ woken: 1, failed: 1 });
    expect(order).toEqual(['wake:1', 'kill:1']);
    expect(logs).toContainEqual({
      event: 'worker.kill_signal_failed',
      fields: { tenant_id: TENANT, intent_id: killing[1]!.intentId },
    });
    expect(JSON.stringify(logs)).not.toContain('down');
  });
});
