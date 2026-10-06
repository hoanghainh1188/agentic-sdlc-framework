// D-08 E08 (design/ADR-M53): the rules of the Langfuse purge that need no database.
// - `traceBelongs`: a trace is deleted only when it carries exactly one tenant, project, intent and
//   run tag, and they are this tenant's and project's slugs, this intent's code and one of its
//   runs. Another tenant's or project's trace, a renamed slug (§2.2) or a trace without labels
//   never matches.
// - `langfuseFinish`: the raw OTLP sweep by age (fake clock), its cap per pass, `report` mode;
//   the ClickHouse compaction only when owed, only in `purge` mode, at most once per UTC day.
// The selection and the audit: tests/integration/db/langfuse-purge.test.ts.
import {
  EvidenceError,
  type EvidenceKeyInfo,
  type EvidenceRetentionStore,
  type LlmTraceStore,
} from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

import {
  langfuseFinish,
  langfuseStart,
  traceBelongs,
  type LangfusePurgeState,
} from '../../packages/core/src/retention/langfuse-pass.js';
import type { RetentionCounts, RetentionPassDeps } from '../../packages/core/src/retention/pass.js';

const RUN = '11111111-1111-4111-8111-111111111111';
const OTHER_RUN = '22222222-2222-4222-8222-222222222222';
const expected = {
  tenant: 'acme',
  project: 'shop',
  intentCode: 'INT-2026-0001',
  runIds: new Set([RUN]),
};
const tags = (over: Record<string, string | string[] | null> = {}) => {
  const base: Record<string, string | string[] | null> = {
    tenant: 'acme',
    project: 'shop',
    intent_id: 'INT-2026-0001',
    run_id: RUN,
    gate: 'G4',
    agent: 'coder',
    data_class: 'internal',
    ...over,
  };
  return Object.entries(base).flatMap(([label, value]) =>
    value === null ? [] : (Array.isArray(value) ? value : [value]).map((v) => `${label}:${v}`),
  );
};

describe('E08: traceBelongs', () => {
  it('matches a trace of this tenant, project, intent and one of its runs', () => {
    expect(traceBelongs({ traceId: 't', tags: tags() }, expected)).toBe(true);
  });

  it.each([
    ['another tenant', { tenant: 'other' }],
    ['another project', { project: 'other' }],
    ['another intent', { intent_id: 'INT-2026-0002' }],
    ['a run of another intent', { run_id: OTHER_RUN }],
    ['a renamed tenant slug', { tenant: 'acme-old' }],
    ['a renamed project slug', { project: 'shop-old' }],
    ['no tenant tag', { tenant: null }],
    ['no run tag', { run_id: null }],
    ['two tenant tags', { tenant: ['acme', 'other'] }],
    ['two run tags', { run_id: [RUN, OTHER_RUN] }],
    ['a prefix of the slug', { tenant: 'acm' }],
  ])('never matches %s', (_name, over) => {
    expect(traceBelongs({ traceId: 't', tags: tags(over) }, expected)).toBe(false);
  });

  it('never matches a trace without labels', () => {
    expect(traceBelongs({ traceId: 't', tags: [] }, expected)).toBe(false);
  });
});

const HOUR = 3_600_000;
const NOW = new Date('2026-10-05T12:00:00.000Z');

function rawStore(keys: EvidenceKeyInfo[], pageSize = 1000) {
  const deleted: string[] = [];
  const store: EvidenceRetentionStore = {
    listKeys: (_prefix, after, limit) => {
      const start = after === null ? 0 : keys.findIndex((k) => k.uri.endsWith(after)) + 1;
      const page = keys.slice(start, start + Math.min(limit, pageSize));
      const more = start + page.length < keys.length;
      return Promise.resolve({
        keys: page,
        next: more ? page.at(-1)!.uri.slice('s3://langfuse/'.length) : null,
      });
    },
    deleteAllVersions: (uri) => {
      deleted.push(uri);
      return Promise.resolve(1);
    },
    setLegalHold: () => Promise.reject(new EvidenceError('forbidden')),
    extendLock: () => Promise.reject(new EvidenceError('forbidden')),
  };
  return { store, deleted };
}

const key = (name: string, ageHours: number): EvidenceKeyInfo => ({
  uri: `s3://langfuse/events/otel/sdlc-platform/${name}.json`,
  lastModified: new Date(NOW.getTime() - ageHours * HOUR),
});

function finishDeps(options: {
  mode: 'report' | 'purge';
  raw: EvidenceRetentionStore;
  state: LangfusePurgeState;
  now?: Date;
  rawBatch?: number;
  compact?: () => Promise<{ durationMs: number }>;
  projectId?: Promise<string>;
}) {
  if (options.state.verified === undefined) options.state.verified = true;
  const logs: { event: string; fields: Record<string, unknown> }[] = [];
  let compactions = 0;
  const store: LlmTraceStore = {
    projectId: () => options.projectId ?? Promise.resolve('sdlc-platform'),
    findTraces: () => Promise.reject(new Error('not used')),
    deleteTraces: () => Promise.reject(new Error('not used')),
    compactDeleted: () => {
      compactions += 1;
      return options.compact ? options.compact() : Promise.resolve({ durationMs: 42 });
    },
  };
  const deps = {
    now: () => options.now ?? NOW,
    logger: { log: (_l: string, event: string, fields = {}) => logs.push({ event, fields }) },
    settings: { mode: options.mode },
    langfuse: {
      status: 'on',
      store,
      rawStore: options.raw,
      rawPrefix: 'events/otel/',
      settings: {
        batch: 50,
        rawMaxAgeHours: 24,
        rawBatch: options.rawBatch ?? 100,
        projectId: 'sdlc-platform',
        guardPercent: 20,
        guardFloor: 20,
      },
      state: options.state,
    },
  } as unknown as RetentionPassDeps;
  const counts = {
    failed: 0,
    langfuseRawFound: 0,
    langfuseRawSwept: 0,
    langfuseCompacted: 0,
  } as RetentionCounts;
  return { deps, counts, logs, compactions: () => compactions };
}

describe('E08: the raw OTLP sweep', () => {
  it('deletes files older than the maximum age (24 h), keeps younger ones', async () => {
    const { store, deleted } = rawStore([key('a', 25), key('b', 24), key('c', 23.9), key('d', 1)]);
    const t = finishDeps({ mode: 'purge', raw: store, state: { maskOwed: false, maskedOn: null } });
    await langfuseFinish(t.deps, t.counts);
    expect(deleted.map((u) => u.split('/').at(-1))).toEqual(['a.json', 'b.json']);
    expect(t.counts).toMatchObject({ langfuseRawFound: 2, langfuseRawSwept: 2 });
  });

  it('report mode counts and deletes nothing', async () => {
    const { store, deleted } = rawStore([key('a', 30), key('b', 30)]);
    const t = finishDeps({ mode: 'report', raw: store, state: { maskOwed: true, maskedOn: null } });
    await langfuseFinish(t.deps, t.counts);
    expect(deleted).toEqual([]);
    expect(t.counts).toMatchObject({ langfuseRawFound: 2, langfuseRawSwept: 0 });
    expect(t.compactions()).toBe(0);
  });

  it('stops at the cap per pass and reads further pages until then', async () => {
    const keys = Array.from({ length: 7 }, (_, i) => key(`k${i}`, 48));
    const { store, deleted } = rawStore(keys, 2);
    const t = finishDeps({
      mode: 'purge',
      raw: store,
      state: { maskOwed: false, maskedOn: null },
      rawBatch: 5,
    });
    await langfuseFinish(t.deps, t.counts);
    expect(deleted).toHaveLength(5);
  });

  it('a failed sweep is counted and logged by code; the compaction still runs', async () => {
    const { store } = rawStore([key('a', 30)]);
    const failing = { ...store, listKeys: () => Promise.reject(new EvidenceError('forbidden')) };
    const t = finishDeps({
      mode: 'purge',
      raw: failing,
      state: { maskOwed: true, maskedOn: null },
    });
    await langfuseFinish(t.deps, t.counts);
    expect(t.counts.failed).toBe(1);
    expect(t.logs.map((l) => l.event)).toContain('retention.langfuse_raw_failed');
    expect(t.logs.find((l) => l.event === 'retention.langfuse_raw_failed')?.fields).toEqual({
      error: 'evidence_forbidden',
    });
    expect(t.compactions()).toBe(1);
  });
});

describe('E08: the ClickHouse compaction', () => {
  it('runs when owed, logs its duration, then not again the same UTC day', async () => {
    const state: LangfusePurgeState = { maskOwed: true, maskedOn: null };
    const { store } = rawStore([]);
    const t = finishDeps({ mode: 'purge', raw: store, state });
    await langfuseFinish(t.deps, t.counts);
    expect(t.compactions()).toBe(1);
    expect(state).toMatchObject({ maskOwed: false, maskedOn: '2026-10-05' });
    expect(t.logs.find((l) => l.event === 'retention.langfuse_compacted')?.fields).toEqual({
      duration_ms: 42,
    });
    // Owed again the same day: waits for the next day.
    state.maskOwed = true;
    const later = finishDeps({
      mode: 'purge',
      raw: store,
      state,
      now: new Date('2026-10-05T23:59:00.000Z'),
    });
    await langfuseFinish(later.deps, later.counts);
    expect(later.compactions()).toBe(0);
    const nextDay = finishDeps({
      mode: 'purge',
      raw: store,
      state,
      now: new Date('2026-10-06T00:01:00.000Z'),
    });
    await langfuseFinish(nextDay.deps, nextDay.counts);
    expect(nextDay.compactions()).toBe(1);
  });

  it('never runs when nothing is owed', async () => {
    const { store } = rawStore([]);
    const t = finishDeps({ mode: 'purge', raw: store, state: { maskOwed: false, maskedOn: null } });
    await langfuseFinish(t.deps, t.counts);
    expect(t.compactions()).toBe(0);
  });

  it('a failed compaction stays owed and is retried on the next pass', async () => {
    const state: LangfusePurgeState = { maskOwed: true, maskedOn: null };
    const { store } = rawStore([]);
    const t = finishDeps({
      mode: 'purge',
      raw: store,
      state,
      compact: () => Promise.reject(new Error('x')),
    });
    await langfuseFinish(t.deps, t.counts);
    expect(state).toMatchObject({ maskOwed: true, maskedOn: null });
    expect(t.counts.failed).toBe(1);
  });
});

describe('E08: the key belongs to the expected Langfuse project (review of E08)', () => {
  it('verifies the project once per pass; another project or no answer: nothing runs', async () => {
    const { store, deleted } = rawStore([key('a', 30)]);
    for (const [answer, verified] of [
      [Promise.resolve('sdlc-platform'), true],
      [Promise.resolve('another-project'), false],
      [Promise.reject(new Error('down')), false],
    ] as const) {
      const state: LangfusePurgeState = { maskOwed: true, maskedOn: null, verified: undefined };
      const t = finishDeps({ mode: 'purge', raw: store, state, projectId: answer });
      await langfuseStart(t.deps);
      expect(state.verified).toBe(verified);
      if (!verified) {
        expect(t.logs.map((l) => l.event)).toEqual([
          expect.stringMatching(/^retention\.langfuse_(project_mismatch|unavailable)$/),
        ]);
        await langfuseFinish(t.deps, t.counts);
        // Not verified: no raw sweep and no compaction (Langfuse may not have ingested yet).
        expect(t.compactions()).toBe(0);
        expect(t.counts.langfuseRawSwept).toBe(0);
      }
    }
    expect(deleted).toEqual([]);
  });
});
