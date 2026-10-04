// D-08 E05 (design/ADR-M51): the worker's retention loop. One pass under the advisory lock; another
// holder → busy, nothing runs; the orphan sweep's cursor carries from one pass to the next; a failed
// pass is logged by its code and never thrown; logs hold counts and codes only. The pass itself:
// tests/integration/db/retention.test.ts.
import type { RetentionPassResult } from '../../packages/core/src/retention/pass.js';
import { describe, expect, it } from 'vitest';

import { RetentionLoop, type RetentionLoopDeps } from '../../apps/worker/src/retention-loop.js';

const counts = {
  eligible: 2,
  purged: 2,
  refused: 0,
  failed: 0,
  locksExtended: 0,
  holdsApplied: 1,
  holdsReleased: 0,
  guardTripped: 0,
  projectsPurged: 0,
  archivesScheduled: 0,
  orphansFound: 0,
  orphansSwept: 0,
};

function harness() {
  const state = { busy: false, fail: false, cursors: [] as (string | null)[], next: 'packs/a' };
  const logs: { level: string; event: string; fields: Record<string, unknown> }[] = [];
  const deps: RetentionLoopDeps = {
    pass: (cursor) => {
      state.cursors.push(cursor);
      if (state.fail) {
        return Promise.reject(
          Object.assign(new Error('secret text'), { code: 'evidence_unavailable' }),
        );
      }
      const result: RetentionPassResult = { ...counts, orphanCursor: state.next };
      return Promise.resolve(result);
    },
    withLock: async (fn) => (state.busy ? { ran: false } : { ran: true, value: await fn() }),
    logger: { log: (level, event, fields = {}) => logs.push({ level, event, fields }) },
    mode: 'report',
    intervalMs: 60_000,
  };
  return { state, logs, loop: new RetentionLoop(deps) };
}

describe('E05: the retention loop', () => {
  it('runs one pass under the lock and logs its counts and mode', async () => {
    const { loop, logs } = harness();
    const pass = await loop.tick();
    expect(pass.outcome).toBe('done');
    const line = logs.find((l) => l.event === 'worker.retention_pass');
    expect(line?.fields).toMatchObject({ mode: 'report', purged: 2, holdsApplied: 1 });
    expect(line?.level).toBe('info');
  });

  it('carries the orphan cursor to the next pass', async () => {
    const { loop, state } = harness();
    await loop.tick();
    state.next = 'packs/b';
    await loop.tick();
    expect(state.cursors).toEqual([null, 'packs/a']);
  });

  it('does nothing while another process holds the lock', async () => {
    const { loop, state, logs } = harness();
    state.busy = true;
    expect((await loop.tick()).outcome).toBe('busy');
    expect(state.cursors).toEqual([]);
    expect(logs.map((l) => l.event)).toEqual(['worker.retention_busy']);
  });

  it('never throws: a failed pass is logged by its code, never its text', async () => {
    const { loop, state, logs } = harness();
    state.fail = true;
    expect((await loop.tick()).outcome).toBe('failed');
    expect(logs).toEqual([
      {
        level: 'error',
        event: 'worker.retention_failed',
        fields: { error: 'evidence_unavailable' },
      },
    ]);
    expect(JSON.stringify(logs)).not.toContain('secret text');
  });

  it('stops cleanly', async () => {
    const { loop } = harness();
    loop.start();
    await loop.stop();
  });
});
