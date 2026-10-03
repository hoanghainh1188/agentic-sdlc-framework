// HTTP calls to the GitHub REST API on Node's built-in fetch (design/ADR-M23 §2.1).
//
// - GETs are retried after a network error, a timeout or a 5xx answer (exponential backoff).
//   POSTs are never retried here: a retry could post a comment twice. The caller decides.
// - Rate limits: a 403 or 429 with `x-ratelimit-remaining: 0` or `retry-after` is
//   `rate_limited` with the time to retry. The adapter never sleeps until the reset.
// - Conditional requests: list calls send `If-None-Match`; a 304 answer does not count against the
//   rate limit and reuses the cached body.
// - The Authorization header value is never logged and never put in an error.
import { GitHostError, type GitHostErrorCode } from '@sdlc/contracts';

import type { ResolvedOptions } from './options.js';

export interface GitHubResponse {
  readonly status: number;
  readonly body: unknown;
  /** Server time from the `Date` header, or null. */
  readonly date: Date | null;
  /** The `rel="next"` page URL (checked to stay on the API host), or null. */
  readonly next: string | null;
}

export interface RequestInput {
  /** Value of the Authorization header (`Bearer …`). */
  readonly auth: string;
  readonly body?: unknown;
  readonly query?: Readonly<Record<string, string | number>>;
  /** Use conditional requests (ETag) for this GET. */
  readonly cache?: boolean;
}

const API_VERSION = '2022-11-28';
const MAX_JSON_BYTES = 10 * 1024 * 1024;
const ETAG_CACHE_SIZE = 256;
const RATE_LIMIT_LOW = 200;

interface CacheEntry {
  readonly etag: string;
  readonly body: unknown;
  readonly next: string | null;
}

class Retryable extends Error {
  constructor(readonly failure: GitHostError) {
    super(failure.message);
  }
}

export class GitHubHttp {
  readonly #options: ResolvedOptions;
  readonly #etags = new Map<string, CacheEntry>();

  constructor(options: ResolvedOptions) {
    this.#options = options;
  }

  /** Builds the URL of an API path such as `repos/o/r/pulls/1`. */
  url(path: string, query: RequestInput['query'] = {}): URL {
    if (path.split('/').some((s) => s === '' || s === '.' || s === '..')) {
      throw new GitHostError('invalid_input', { field: 'path' });
    }
    const url = new URL(path, this.#options.apiUrl);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
    return url;
  }

  /** A JSON call. `pathOrUrl` is an API path or a `next` URL returned earlier. */
  async json(
    method: 'GET' | 'POST' | 'DELETE',
    pathOrUrl: string | URL,
    input: RequestInput,
  ): Promise<GitHubResponse> {
    const target = typeof pathOrUrl === 'string' ? this.url(pathOrUrl, input.query) : pathOrUrl;
    this.#checkOnApiHost(target);
    return this.#withRetries(method, async () => {
      const key = target.toString();
      const cached = method === 'GET' && input.cache ? this.#etags.get(key) : undefined;
      const headers: Record<string, string> = {
        Accept: 'application/vnd.github+json',
        ...this.#baseHeaders(input.auth),
      };
      if (cached) headers['If-None-Match'] = cached.etag;
      let payload: string | undefined;
      if (input.body !== undefined) {
        payload = JSON.stringify(input.body);
        headers['Content-Type'] = 'application/json';
      }
      const res = await this.#fetch(target, { method, headers, body: payload });
      const date = parseDate(res.headers.get('date'));
      this.#watchRateLimit(res);
      if (res.status === 304 && cached) {
        await res.body?.cancel();
        return { status: 200, body: cached.body, date, next: cached.next };
      }
      if (res.status < 200 || res.status >= 300) throw await this.#failure(res);
      const text = (await readCapped(res, MAX_JSON_BYTES, 'invalid_response')).toString('utf8');
      let body: unknown = undefined;
      if (text.length > 0) {
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          throw new GitHostError('invalid_response', { field: 'body' });
        }
      }
      const next = this.#nextLink(res.headers.get('link'));
      const etag = res.headers.get('etag');
      if (method === 'GET' && input.cache && etag) this.#remember(key, { etag, body, next });
      return { status: res.status, body, date, next };
    });
  }

  /** A raw file (`application/vnd.github.raw+json`), at most `maxBytes`. */
  async raw(path: string, input: RequestInput, maxBytes: number): Promise<Buffer> {
    const target = this.url(path, input.query);
    return this.#withRetries('GET', async () => {
      const res = await this.#fetch(target, {
        method: 'GET',
        headers: { Accept: 'application/vnd.github.raw+json', ...this.#baseHeaders(input.auth) },
      });
      this.#watchRateLimit(res);
      if (res.status < 200 || res.status >= 300) throw await this.#failure(res);
      // A directory answers with a JSON list instead of the raw media type.
      if (!(res.headers.get('content-type') ?? '').includes('vnd.github.raw')) {
        await res.body?.cancel();
        throw new GitHostError('not_a_file');
      }
      const length = Number(res.headers.get('content-length') ?? '0');
      if (length > maxBytes) {
        await res.body?.cancel();
        throw new GitHostError('file_too_large', { max_bytes: maxBytes });
      }
      return readCapped(res, maxBytes, 'file_too_large');
    });
  }

  #baseHeaders(auth: string): Record<string, string> {
    return {
      Authorization: auth,
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': 'sdlc-platform',
    };
  }

  async #fetch(url: URL, init: { method: string; headers: Record<string, string>; body?: string }) {
    try {
      return await fetch(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(this.#options.requestTimeoutMs),
      });
    } catch (error) {
      const timeout = error instanceof Error && error.name === 'TimeoutError';
      throw new Retryable(new GitHostError(timeout ? 'timeout' : 'network_error'));
    }
  }

  async #withRetries<T>(method: 'GET' | 'POST' | 'DELETE', attempt: () => Promise<T>): Promise<T> {
    for (let i = 0; ; i += 1) {
      try {
        return await attempt();
      } catch (error) {
        if (!(error instanceof Retryable)) throw error;
        if (method !== 'GET' || i >= this.#options.maxRetries) throw error.failure;
        this.#options.logger.log('warn', 'git_host.request_retry', {
          code: error.failure.code,
          attempt: i + 1,
          ...(typeof error.failure.params.status === 'number'
            ? { status: error.failure.params.status }
            : {}),
        });
        await this.#options.sleep(this.#options.retryBaseDelayMs * 2 ** i);
      }
    }
  }

  async #failure(res: Response): Promise<Error> {
    await res.body?.cancel();
    const status = res.status;
    const remaining = res.headers.get('x-ratelimit-remaining');
    const retryAfter = res.headers.get('retry-after');
    if ((status === 403 || status === 429) && (remaining === '0' || retryAfter !== null)) {
      const retryAt = this.#retryAt(retryAfter, res.headers.get('x-ratelimit-reset'));
      this.#options.logger.log('warn', 'git_host.rate_limited', { status, retry_at: retryAt });
      return new GitHostError('rate_limited', { retry_at: retryAt });
    }
    if (status >= 500) return new Retryable(new GitHostError('server_error', { status }));
    const code: GitHostErrorCode =
      status === 401
        ? 'auth_failed'
        : status === 403
          ? 'forbidden'
          : status === 404
            ? 'not_found'
            : 'rejected';
    return new GitHostError(code, { status });
  }

  #retryAt(retryAfter: string | null, reset: string | null): string {
    const now = this.#options.now().getTime();
    const seconds = Number(retryAfter);
    if (retryAfter !== null && Number.isFinite(seconds) && seconds >= 0) {
      return new Date(now + seconds * 1000).toISOString();
    }
    const resetEpoch = Number(reset);
    if (reset !== null && Number.isFinite(resetEpoch) && resetEpoch > 0) {
      return new Date(resetEpoch * 1000).toISOString();
    }
    return new Date(now + 60_000).toISOString();
  }

  #watchRateLimit(res: Response): void {
    const remaining = Number(res.headers.get('x-ratelimit-remaining'));
    if (res.headers.has('x-ratelimit-remaining') && remaining < RATE_LIMIT_LOW && remaining > 0) {
      this.#options.logger.log('warn', 'git_host.rate_limit_low', { remaining });
    }
  }

  #checkOnApiHost(url: URL): void {
    const api = this.#options.apiUrl;
    if (url.origin !== api.origin || !url.pathname.startsWith(api.pathname)) {
      // Never send the token to another host.
      throw new GitHostError('invalid_response', { field: 'link' });
    }
  }

  #nextLink(header: string | null): string | null {
    if (!header) return null;
    for (const part of header.split(',')) {
      const match = /^\s*<([^>]+)>\s*;\s*rel="([^"]+)"/.exec(part);
      if (match?.[2]?.split(' ').includes('next') && match[1]) {
        let next: URL;
        try {
          next = new URL(match[1]);
        } catch {
          throw new GitHostError('invalid_response', { field: 'link' });
        }
        this.#checkOnApiHost(next);
        return next.toString();
      }
    }
    return null;
  }

  #remember(key: string, entry: CacheEntry): void {
    this.#etags.delete(key);
    this.#etags.set(key, entry);
    if (this.#etags.size > ETAG_CACHE_SIZE) {
      const oldest = this.#etags.keys().next().value;
      if (oldest !== undefined) this.#etags.delete(oldest);
    }
  }
}

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function readCapped(
  res: Response,
  maxBytes: number,
  code: 'invalid_response' | 'file_too_large',
): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    let chunk: { done: boolean; value?: Uint8Array };
    try {
      chunk = (await reader.read()) as { done: boolean; value?: Uint8Array };
    } catch {
      throw new GitHostError('network_error');
    }
    if (chunk.done || !chunk.value) break;
    size += chunk.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw code === 'file_too_large'
        ? new GitHostError('file_too_large', { max_bytes: maxBytes })
        : new GitHostError('invalid_response', { field: 'size' });
    }
    chunks.push(Buffer.from(chunk.value));
  }
  return Buffer.concat(chunks);
}
