// The only place that talks to the API (design/ADR-M54 §2.1, §2.3): GET requests to the same
// origin, the token in the Authorization header only, every body checked with the CLI's zod
// schemas (`@sdlc/api-schemas`). A static test refuses any other `fetch` or method.
import { errorEnvelopeSchema } from '@sdlc/api-schemas';
import type { z } from 'zod';

import { session } from '../session.js';

/** A refusal or a failure, by code. `status` 0: the request never got an API answer. */
export class ApiError extends Error {
  override readonly name = 'ApiError';
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export type Query = Readonly<Record<string, string | number | undefined>>;

/** `/v1/…` with its query; every value is encoded. */
export function apiPath(path: string, query: Query = {}): string {
  if (!path.startsWith('/v1/')) throw new ApiError(0, 'invalid_path');
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const search = params.toString();
  return search === '' ? path : `${path}?${search}`;
}

/** One path segment from server data or a route (an intent code, a slug, a version). */
export function segment(value: string | number): string {
  return encodeURIComponent(String(value));
}

/** GET with an explicit token (sign-in) or the session's. */
export async function getJson<S extends z.ZodType>(
  path: string,
  schema: S,
  options: { readonly signal?: AbortSignal; readonly token?: string } = {},
): Promise<z.infer<S>> {
  const token = options.token ?? session.token();
  if (token === null) throw new ApiError(401, 'unauthorized');
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      mode: 'same-origin',
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, 'network');
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const envelope = errorEnvelopeSchema.safeParse(body);
    const code = envelope.success ? envelope.data.error.code : 'unexpected';
    // An expired or revoked token ends the session; the person signs in again.
    if (response.status === 401 && options.token === undefined && session.token() === token) {
      session.signOut();
    }
    throw new ApiError(response.status, code);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ApiError(response.status, 'invalid_response');
  return parsed.data;
}
