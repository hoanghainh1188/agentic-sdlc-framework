// HTTP client of the user commands (design/ADR-M36 §2.3). Every response is external data: its
// size is capped, it must be JSON and it is validated by the caller's schema. TLS is verified by
// Node and cannot be turned off; redirects are refused, so the token never goes to another host.
// Errors never carry request headers, so the token cannot reach an error message.
import { DEFAULT_LOCALE } from '@sdlc/messages';
import type { z } from 'zod';

import { errorEnvelopeSchema, type ErrorEnvelope } from './schemas.js';

export const API_TIMEOUT_MS = 30_000;
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export type ApiFailureKind =
  /** The API answered with an error status. */
  'http' | 'network' | 'timeout' | 'redirect' | 'too_large' | 'malformed';

export class ApiCallError extends Error {
  constructor(
    readonly kind: ApiFailureKind,
    readonly status?: number,
    readonly envelope?: ErrorEnvelope,
  ) {
    super(`api_${kind}`);
  }
}

export interface ApiClientOptions {
  readonly apiUrl: string;
  readonly token: string;
  readonly fetch: typeof fetch;
  readonly timeoutMs?: number;
}

type Query = Readonly<Record<string, string | number | undefined>>;

export class ApiClient {
  constructor(private readonly options: ApiClientOptions) {}

  /** `maxBytes`: a larger cap for one answer (C13: a proposal); default `MAX_RESPONSE_BYTES`. */
  get<T>(
    path: string,
    schema: z.ZodType<T>,
    query: Query = {},
    maxBytes: number = MAX_RESPONSE_BYTES,
  ): Promise<T> {
    return this.request('GET', path, schema, undefined, query, maxBytes);
  }

  post<T>(path: string, schema: z.ZodType<T>, body: unknown = {}): Promise<T> {
    return this.request('POST', path, schema, body);
  }

  put<T>(path: string, schema: z.ZodType<T>, body: unknown): Promise<T> {
    return this.request('PUT', path, schema, body);
  }

  patch<T>(path: string, schema: z.ZodType<T>, body: unknown): Promise<T> {
    return this.request('PATCH', path, schema, body);
  }

  delete<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    return this.request('DELETE', path, schema, undefined);
  }

  private async request<T>(
    method: string,
    path: string,
    schema: z.ZodType<T>,
    body: unknown,
    query: Query = {},
    maxBytes: number = MAX_RESPONSE_BYTES,
  ): Promise<T> {
    const url = new URL(`${this.options.apiUrl}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.options.token}`,
      accept: 'application/json',
      'accept-language': DEFAULT_LOCALE,
      'user-agent': 'sdlc-cli',
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await this.options.fetch(url, {
        method,
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.options.timeoutMs ?? API_TIMEOUT_MS),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new ApiCallError(isTimeout(error) ? 'timeout' : 'network');
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new ApiCallError('redirect', response.status);
    }
    const json = await readJson(response, maxBytes);
    if (!response.ok) {
      const envelope = errorEnvelopeSchema.safeParse(json);
      throw new ApiCallError('http', response.status, envelope.success ? envelope.data : undefined);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new ApiCallError('malformed', response.status);
    return parsed.data;
  }
}

/** Reads at most `maxBytes` and parses JSON. Undefined for an empty body. */
async function readJson(response: Response, maxBytes: number): Promise<unknown> {
  if (response.body === null) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    // Leaving the loop early cancels the stream.
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      if (size > maxBytes) throw new ApiCallError('too_large', response.status);
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof ApiCallError) throw error;
    throw new ApiCallError(isTimeout(error) ? 'timeout' : 'network', response.status);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiCallError('malformed', response.status);
  }
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}
