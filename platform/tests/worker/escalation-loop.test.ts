// D-08 B11 AC3 (scheduling part): the escalation clock loop advances every due escalation, keeps
// going when one fails, and logs codes only (design/ADR-M28 §2.2). The clock itself:
// tests/escalation/clock.test.ts; the database part: tests/integration/db/escalations.test.ts.
import { describe, expect, it } from 'vitest';

import { EscalationLoop, type EscalationLoopDeps } from '../../apps/worker/src/escalation-loop.js';

type Due = Awaited<ReturnType<EscalationLoopDeps['listDue']>>[number];

const TENANT = '00000000-0000-4000-8000-000000000001' as Due['tenantId'];
const due = (id: string): Due => ({ tenantId: TENANT, escalationId: id });

function harness(items: Due[], failing: ReadonlySet<string> = new Set()) {
  const calls: { listed: number[]; advanced: string[] } = { listed: [], advanced: [] };
  const logs: { level: string; event: string; fields: Record<string, unknown> }[] = [];
  const now = new Date('2026-09-28T03:00:00Z');
  const loop = new EscalationLoop({
    listDue: (_now, limit) => {
      calls.listed.push(limit);
      return Promise.resolve(items.slice(0, limit));
    },
    advance: (item) => {
      calls.advanced.push(item.escalationId);
      if (failing.has(item.escalationId)) {
        return Promise.reject(Object.assign(new Error('boom'), { code: 'immutable' }));
      }
      return Promise.resolve({
        outcome: 'advanced',
        effects: [{ kind: 'reminded', at: now, step: 'owner' }],
      });
    },
    now: () => now,
    logger: { log: (level, event, fields) => logs.push({ level, event, fields: { ...fields } }) },
    batchSize: 2,
  });
  return { loop, calls, logs };
}

describe('escalation clock loop', () => {
  it('advances the due escalations of one batch', async () => {
    const h = harness([due('e1'), due('e2'), due('e3')]);
    await h.loop.tick();
    expect(h.calls.listed).toEqual([2]);
    expect(h.calls.advanced).toEqual(['e1', 'e2']);
    expect(h.logs.map((l) => l.event)).toEqual([
      'worker.escalation_clock',
      'worker.escalation_clock',
    ]);
    expect(h.logs[0]?.fields).toEqual({
      tenant_id: TENANT,
      escalation_id: 'e1',
      effect: 'reminded',
    });
  });

  it('an error skips only that escalation and logs its code, never the message', async () => {
    const h = harness([due('e1'), due('e2')], new Set(['e1']));
    await h.loop.tick();
    expect(h.calls.advanced).toEqual(['e1', 'e2']);
    const failed = h.logs.find((l) => l.event === 'worker.escalation_failed');
    expect(failed?.level).toBe('error');
    expect(failed?.fields).toEqual({ tenant_id: TENANT, escalation_id: 'e1', error: 'immutable' });
    expect(JSON.stringify(h.logs)).not.toContain('boom');
  });

  it('stops cleanly: the tick in progress ends and no escalation is started after stop', async () => {
    const h = harness([due('e1'), due('e2')]);
    h.loop.start(60_000);
    await h.loop.stop();
    expect(h.calls.listed).toEqual([2]);
    expect(h.calls.advanced).toEqual([]);
  });
});
