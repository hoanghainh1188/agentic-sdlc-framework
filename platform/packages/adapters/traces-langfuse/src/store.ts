// The model-call trace store on Langfuse v4 (task E08, design/ADR-M53; D-02 FR-44). Checked live
// on Langfuse 4.47.0 in `events_only` mode with ClickHouse 26.3 (spike, ADR-M53 §1):
//
// - Selection: `GET /api/public/v2/observations` with `fields=core,metadata` (never `io`) and the
//   filter `tags any of [...]`. Each observation returns its trace's tags in
//   `metadata["attributes.langfuse.trace.tags"]`. A filter Langfuse cannot read is refused with
//   400 (fail closed), never answered without the filter. Paged with `meta.cursor`.
// - Delete: `DELETE /api/public/traces` (at most 1,000 IDs per call). Langfuse records the request
//   and its worker deletes later (about 5 s): ClickHouse `events_full` and `events_core` (a
//   lightweight `DELETE`: the rows are hidden at once but stay on disk until a merge).
// - `compactDeleted`: `ALTER TABLE … APPLY DELETED MASK` on both tables, as the ClickHouse user
//   `sdlc_purge`, which has only `ALTER DELETE` on them. It removes the hidden rows from disk.
//
// The project key (public and secret) is the worker's own Langfuse key (D3, QUESTIONS #252).
// Langfuse OSS keys have no scopes: the key could also read prompts and ingest. This adapter never
// asks for input or output fields. Errors are codes; no text from either service leaves here.
import {
  LlmTraceError,
  type LlmTraceRef,
  type LlmTraceStore,
  type RedactedSecret,
} from '@sdlc/contracts';

export interface LangfuseTraceStoreOptions {
  /** Langfuse web, for example `http://langfuse-web:3000` (Compose network). An origin only. */
  readonly url: string;
  readonly publicKey: RedactedSecret;
  readonly secretKey: RedactedSecret;
  readonly clickhouse: {
    /** ClickHouse HTTP, for example `http://clickhouse:8123`. An origin only. */
    readonly url: string;
    readonly user: string;
    readonly password: RedactedSecret;
  };
  /** Per request; default 30 000 ms. `compactDeleted` waits for the mutation: 10 minutes. */
  readonly timeoutMs?: number;
  /** For tests. */
  readonly fetch?: typeof fetch;
}

/** The Langfuse tables that hold observations in `events_only` mode (4.47.0). */
export const LANGFUSE_EVENT_TABLES = ['events_full', 'events_core'] as const;
/** Observations per page (Langfuse's maximum). */
export const OBSERVATION_PAGE = 1000;
/** Trace IDs per delete call (Langfuse's maximum). */
export const DELETE_CHUNK = 1000;
/** Tags per selection, at most. */
export const MAX_TAGS_PER_QUERY = 100;
const TRACE_TAGS = 'attributes.langfuse.trace.tags';
const COMPACT_TIMEOUT_MS = 600_000;
/** Our label tags: `<label>:<value>` (ADR-M24 §2.2, `COST_LABEL_VALUE`). */
const TAG = /^[a-z][a-z_]{0,31}:[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
/** Langfuse trace IDs from OpenTelemetry: 32 hex characters. Others are accepted, never odd ones. */
const TRACE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const CLICKHOUSE_USER = /^[a-z][a-z0-9_]{0,63}$/;

function origin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LlmTraceError('invalid_input');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new LlmTraceError('invalid_input');
  }
  return url.origin;
}

interface ObservationPage {
  readonly data?: unknown;
  readonly meta?: { readonly cursor?: unknown };
}

export class LangfuseTraceStore implements LlmTraceStore {
  readonly #url: string;
  readonly #auth: string;
  readonly #clickhouse: LangfuseTraceStoreOptions['clickhouse'] & { readonly url: string };
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: LangfuseTraceStoreOptions) {
    this.#url = origin(options.url);
    if (!CLICKHOUSE_USER.test(options.clickhouse.user)) throw new LlmTraceError('invalid_input');
    this.#clickhouse = { ...options.clickhouse, url: origin(options.clickhouse.url) };
    this.#auth = Buffer.from(
      `${options.publicKey.reveal()}:${options.secretKey.reveal()}`,
      'utf8',
    ).toString('base64');
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#fetch = options.fetch ?? fetch;
  }

  async projectId(): Promise<string> {
    // A project key sees exactly its own project (Langfuse 4.47.0, `GET /api/public/projects`).
    const answer = (await this.#langfuse('GET', '/api/public/projects')) as {
      data?: unknown;
    } | null;
    const data = answer?.data;
    if (!Array.isArray(data) || data.length !== 1) throw new LlmTraceError('unavailable');
    const id = (data[0] as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || !TRACE_ID.test(id)) throw new LlmTraceError('unavailable');
    return id;
  }

  async findTraces(input: {
    readonly tags: readonly string[];
    readonly max: number;
  }): Promise<readonly LlmTraceRef[]> {
    const { tags, max } = input;
    if (
      tags.length === 0 ||
      tags.length > MAX_TAGS_PER_QUERY ||
      !tags.every((tag) => TAG.test(tag)) ||
      !Number.isSafeInteger(max) ||
      max < 1
    ) {
      throw new LlmTraceError('invalid_input');
    }
    const filter = JSON.stringify([
      { type: 'arrayOptions', column: 'tags', operator: 'any of', value: [...tags] },
    ]);
    const traces = new Map<string, Set<string>>();
    let cursor: string | undefined;
    // A trace has a handful of observations; more pages than this means a wrong answer.
    const maxPages = Math.ceil(max / OBSERVATION_PAGE) * 20 + 1;
    for (let page = 0; ; page++) {
      if (page >= maxPages) throw new LlmTraceError('too_many');
      const query = new URLSearchParams({
        limit: String(OBSERVATION_PAGE),
        fields: 'core,metadata',
        // From the beginning: never the server's default window (OSS has none; ADR-M53 §2.2).
        fromStartTime: '1970-01-01T00:00:00.000Z',
        filter,
      });
      if (cursor !== undefined) query.set('cursor', cursor);
      const answer = (await this.#langfuse(
        'GET',
        `/api/public/v2/observations?${query.toString()}`,
      )) as ObservationPage;
      if (!Array.isArray(answer.data)) throw new LlmTraceError('unavailable');
      for (const item of answer.data as unknown[]) {
        const observation = item as { traceId?: unknown; metadata?: unknown } | null;
        const traceId = observation?.traceId;
        if (typeof traceId !== 'string' || !TRACE_ID.test(traceId)) {
          throw new LlmTraceError('unavailable');
        }
        const set = traces.get(traceId) ?? new Set<string>();
        const metadata = observation?.metadata as Record<string, unknown> | null | undefined;
        const found = metadata?.[TRACE_TAGS];
        if (Array.isArray(found)) {
          for (const tag of found) if (typeof tag === 'string') set.add(tag);
        }
        traces.set(traceId, set);
        if (traces.size > max) throw new LlmTraceError('too_many');
      }
      const next = answer.meta?.cursor;
      if (typeof next !== 'string' || next === '') break;
      cursor = next;
    }
    return [...traces].map(([traceId, set]) => ({ traceId, tags: [...set].sort() }));
  }

  async deleteTraces(traceIds: readonly string[]): Promise<void> {
    if (!traceIds.every((id) => TRACE_ID.test(id))) throw new LlmTraceError('invalid_input');
    for (let start = 0; start < traceIds.length; start += DELETE_CHUNK) {
      await this.#langfuse('DELETE', '/api/public/traces', {
        traceIds: traceIds.slice(start, start + DELETE_CHUNK),
      });
    }
  }

  async compactDeleted(): Promise<{ readonly durationMs: number }> {
    const started = Date.now();
    for (const table of LANGFUSE_EVENT_TABLES) {
      await this.#clickhouseCommand(`ALTER TABLE default.${table} APPLY DELETED MASK`);
    }
    return { durationMs: Date.now() - started };
  }

  async #langfuse(method: 'GET' | 'DELETE', path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#url}${path}`, {
        method,
        headers: {
          authorization: `Basic ${this.#auth}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      // The cause is dropped on purpose: it can carry the request.
      throw new LlmTraceError('unavailable');
    }
    const text = await response.text().catch(() => '');
    if (response.status === 401 || response.status === 403) throw new LlmTraceError('forbidden');
    if (!response.ok) throw new LlmTraceError('unavailable');
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new LlmTraceError('unavailable');
    }
  }

  async #clickhouseCommand(statement: string): Promise<void> {
    let response: Response;
    try {
      // `mutations_sync=1`: the call returns when the mutation is done, so the duration is real.
      response = await this.#fetch(`${this.#clickhouse.url}/?mutations_sync=1`, {
        method: 'POST',
        headers: {
          'x-clickhouse-user': this.#clickhouse.user,
          'x-clickhouse-key': this.#clickhouse.password.reveal(),
          'content-type': 'text/plain',
        },
        body: statement,
        redirect: 'error',
        signal: AbortSignal.timeout(COMPACT_TIMEOUT_MS),
      });
    } catch {
      throw new LlmTraceError('unavailable');
    }
    await response.text().catch(() => '');
    if (response.status === 401 || response.status === 403) throw new LlmTraceError('forbidden');
    if (!response.ok) {
      // ClickHouse answers 500 with an access error code in the text; never return the text.
      throw new LlmTraceError('unavailable');
    }
  }
}
