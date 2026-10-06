// D-08 E08 (design/ADR-M53): the Langfuse v4 trace store, against a scripted `fetch` that answers
// like Langfuse 4.47.0 and ClickHouse 26.3 (the shapes were checked live, ADR-M53 §1). Selection
// by tag with the exact filter, pages by cursor, tags joined per trace, never input or output;
// the per-intent limit; deletes in chunks of 1,000; the two compactions as `sdlc_purge`; every
// failure a code, never the service's text. The real service: `pnpm test:observability`.
import { DELETE_CHUNK, LangfuseTraceStore } from '@sdlc/adapter-traces-langfuse';
import { LlmTraceError, type RedactedSecret } from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

const secret = (value: string): RedactedSecret =>
  ({ reveal: () => value, toString: () => '[redacted]' }) as RedactedSecret;

interface Call {
  readonly url: URL;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

function scripted(answers: ((call: Call) => Response)[]) {
  const calls: Call[] = [];
  const fetchFn = ((input: string | URL, init: RequestInit = {}) => {
    const call: Call = {
      url: new URL(String(input)),
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    const answer = answers.shift();
    if (!answer) throw new Error('unexpected call');
    return Promise.resolve(answer(call));
  }) as typeof fetch;
  const store = new LangfuseTraceStore({
    url: 'http://langfuse-web:3000',
    publicKey: secret('pk-lf-test'),
    secretKey: secret('sk-lf-test'),
    clickhouse: { url: 'http://clickhouse:8123', user: 'sdlc_purge', password: secret('ch-pw') },
    fetch: fetchFn,
  });
  return { store, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const observation = (traceId: string, tags?: string[]) => ({
  id: `obs-${traceId}-${Math.random()}`,
  traceId,
  type: 'GENERATION',
  metadata: tags ? { 'attributes.langfuse.trace.tags': tags } : { other: 'x' },
});

const RUN_A = 'run_id:11111111-1111-4111-8111-111111111111';
const RUN_B = 'run_id:22222222-2222-4222-8222-222222222222';

describe('E08: LangfuseTraceStore.findTraces', () => {
  it('asks for core and metadata only, with the exact tag filter, from the beginning', async () => {
    const { store, calls } = scripted([() => json({ data: [], meta: {} })]);
    expect(await store.findTraces({ tags: [RUN_A, RUN_B], max: 10 })).toEqual([]);
    const { url, method, headers } = calls[0]!;
    expect(method).toBe('GET');
    expect(url.origin + url.pathname).toBe('http://langfuse-web:3000/api/public/v2/observations');
    expect(url.searchParams.get('fields')).toBe('core,metadata');
    expect(url.searchParams.get('limit')).toBe('1000');
    expect(url.searchParams.get('fromStartTime')).toBe('1970-01-01T00:00:00.000Z');
    expect(JSON.parse(url.searchParams.get('filter')!)).toEqual([
      { type: 'arrayOptions', column: 'tags', operator: 'any of', value: [RUN_A, RUN_B] },
    ]);
    expect(headers.authorization).toBe(
      `Basic ${Buffer.from('pk-lf-test:sk-lf-test').toString('base64')}`,
    );
  });

  it('follows the cursor and joins the tags of every observation of a trace', async () => {
    const { store, calls } = scripted([
      () =>
        json({
          data: [observation('t1', ['tenant:a', RUN_A]), observation('t2', ['tenant:a', RUN_B])],
          meta: { cursor: 'c1' },
        }),
      () => json({ data: [observation('t1', ['project:p']), observation('t1')], meta: {} }),
    ]);
    const traces = await store.findTraces({ tags: [RUN_A, RUN_B], max: 10 });
    expect(calls[1]!.url.searchParams.get('cursor')).toBe('c1');
    expect(traces).toEqual([
      { traceId: 't1', tags: ['project:p', RUN_A, 'tenant:a'].sort() },
      { traceId: 't2', tags: [RUN_B, 'tenant:a'].sort() },
    ]);
  });

  it('fails too_many past the limit: never part of a selection as all of it', async () => {
    const { store } = scripted([
      () => json({ data: [observation('t1', [RUN_A]), observation('t2', [RUN_A])], meta: {} }),
    ]);
    await expect(store.findTraces({ tags: [RUN_A], max: 1 })).rejects.toEqual(
      new LlmTraceError('too_many'),
    );
  });

  it('fails closed with a code: a refused filter, credentials, odd answers, no answer', async () => {
    for (const [answer, code] of [
      [() => json({ message: 'Invalid JSON in filter parameter' }, 400), 'unavailable'],
      [() => json({ message: 'Unauthorized' }, 401), 'forbidden'],
      [() => json({ data: 'nope' }), 'unavailable'],
      [() => json({ data: [{ traceId: '../x' }] }), 'unavailable'],
      [() => new Response('not json', { status: 200 }), 'unavailable'],
      [
        () => {
          throw new Error('ECONNREFUSED http://secret@host');
        },
        'unavailable',
      ],
    ] as const) {
      const { store } = scripted([answer]);
      const error = await store.findTraces({ tags: [RUN_A], max: 5 }).catch((e: unknown) => e);
      expect(error).toEqual(new LlmTraceError(code));
      expect(String((error as Error).message)).not.toMatch(/Invalid|Unauthorized|secret/);
    }
  });

  it('refuses tags, limits and URLs it was not made for, before any call', async () => {
    const { store, calls } = scripted([]);
    for (const tags of [[], ['run_id:a b'], ['no-colon'], Array(101).fill(RUN_A)]) {
      await expect(store.findTraces({ tags, max: 5 })).rejects.toEqual(
        new LlmTraceError('invalid_input'),
      );
    }
    await expect(store.findTraces({ tags: [RUN_A], max: 0 })).rejects.toEqual(
      new LlmTraceError('invalid_input'),
    );
    expect(calls).toHaveLength(0);
    for (const url of ['http://u:p@langfuse:3000', 'http://langfuse:3000/x', 'ftp://langfuse']) {
      expect(
        () =>
          new LangfuseTraceStore({
            url,
            publicKey: secret('a'),
            secretKey: secret('b'),
            clickhouse: { url: 'http://ch:8123', user: 'sdlc_purge', password: secret('c') },
          }),
      ).toThrow(LlmTraceError);
    }
  });
});

describe('E08: LangfuseTraceStore.deleteTraces and compactDeleted', () => {
  it('deletes in chunks of 1,000 trace IDs', async () => {
    const ids = Array.from({ length: DELETE_CHUNK + 1 }, (_, i) => `t${i}`);
    const ok = () => json({ message: 'Traces deleted successfully' });
    const { store, calls } = scripted([ok, ok]);
    await store.deleteTraces(ids);
    expect(calls.map((c) => [c.method, c.url.pathname])).toEqual([
      ['DELETE', '/api/public/traces'],
      ['DELETE', '/api/public/traces'],
    ]);
    const bodies = calls.map((c) => JSON.parse(c.body!) as { traceIds: string[] });
    expect(bodies[0]!.traceIds).toHaveLength(DELETE_CHUNK);
    expect(bodies[1]!.traceIds).toEqual([`t${DELETE_CHUNK}`]);
    await expect(store.deleteTraces(['bad id'])).rejects.toEqual(
      new LlmTraceError('invalid_input'),
    );
  });

  it('compacts both event tables as sdlc_purge, waiting for the mutation', async () => {
    const ok = () => new Response('', { status: 200 });
    const { store, calls } = scripted([ok, ok]);
    const { durationMs } = await store.compactDeleted();
    expect(durationMs).toBeGreaterThanOrEqual(0);
    expect(calls.map((c) => c.body)).toEqual([
      'ALTER TABLE default.events_full APPLY DELETED MASK',
      'ALTER TABLE default.events_core APPLY DELETED MASK',
    ]);
    for (const call of calls) {
      expect(call.url.toString()).toBe('http://clickhouse:8123/?mutations_sync=1');
      expect(call.headers['x-clickhouse-user']).toBe('sdlc_purge');
      expect(call.headers['x-clickhouse-key']).toBe('ch-pw');
    }
  });

  it('a refused compaction is a code (ClickHouse 497 is HTTP 500, a wrong key 403)', async () => {
    for (const [status, code] of [
      [500, 'unavailable'],
      [403, 'forbidden'],
    ] as const) {
      const { store } = scripted([() => new Response('Code: 497. secret', { status })]);
      await expect(store.compactDeleted()).rejects.toEqual(new LlmTraceError(code));
    }
  });
});

describe('E08: LangfuseTraceStore.projectId', () => {
  it("reads the key's one project; anything else is unavailable", async () => {
    const { store, calls } = scripted([() => json({ data: [{ id: 'sdlc-platform', name: 'x' }] })]);
    expect(await store.projectId()).toBe('sdlc-platform');
    expect(calls[0]!.url.pathname).toBe('/api/public/projects');
    for (const body of [{ data: [] }, { data: [{ id: 'a' }, { id: 'b' }] }, { data: [{}] }, {}]) {
      const { store: other } = scripted([() => json(body)]);
      await expect(other.projectId()).rejects.toEqual(new LlmTraceError('unavailable'));
    }
  });
});
