// The only place that talks to the API (design/ADR-M54 §2.1, §2.3): GET requests to the same
// origin, the token in the Authorization header only, every body checked with the CLI's zod
// schemas (`@sdlc/api-schemas`). A static test refuses any other `fetch` or method.
//
// U05 (ADR-M73 §2.2): with a GitHub sign-in the browser sends its `HttpOnly` session cookie
// (`credentials: 'same-origin'`) and no Authorization header: never both. The only writes are the
// two sign-out calls of `endSession`, which change no intent, gate, run or escalation.
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

/** How a GET authenticates: a token, the session cookie, or nothing (a public read). */
type Credential = { readonly token: string } | { readonly cookie: true } | { readonly none: true };

function credentialFor(options: {
  readonly token?: string;
  readonly cookie?: boolean;
}): Credential {
  if (options.token !== undefined) return { token: options.token };
  if (options.cookie === true) return { cookie: true };
  const token = session.token();
  if (token !== null) return { token };
  if (session.cookie()) return { cookie: true };
  throw new ApiError(401, 'unauthorized');
}

/**
 * GET with an explicit token (sign-in), the session cookie (`cookie: true`: checking for a
 * GitHub sign-in at start), or the tab's current sign-in.
 */
export async function getJson<S extends z.ZodType>(
  path: string,
  schema: S,
  options: {
    readonly signal?: AbortSignal;
    readonly token?: string;
    readonly cookie?: boolean;
  } = {},
): Promise<z.infer<S>> {
  const credential = credentialFor(options);
  const body = await request(path, 'GET', credential, options.signal);
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ApiError(200, 'invalid_response');
  return parsed.data;
}

/** A public GET (no credential at all): `GET /v1/auth/config`. */
export async function getPublicJson<S extends z.ZodType>(
  path: string,
  schema: S,
  options: { readonly signal?: AbortSignal } = {},
): Promise<z.infer<S>> {
  const body = await request(path, 'GET', { none: true }, options.signal);
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ApiError(200, 'invalid_response');
  return parsed.data;
}

/**
 * Ends the GitHub session (U05): `this` = this browser (`POST /v1/auth/sign-out`), `everywhere`
 * = every session of the person (`DELETE /v1/me/sessions`). The browser adds the `Origin` header,
 * which the API checks. Fixed paths only.
 */
export async function endSession(scope: 'this' | 'everywhere'): Promise<void> {
  if (scope === 'this') await request('/v1/auth/sign-out', 'POST', { cookie: true });
  else await request('/v1/me/sessions', 'DELETE', { cookie: true });
}

async function request(
  path: string,
  method: 'GET' | 'POST' | 'DELETE',
  credential: Credential,
  signal?: AbortSignal,
): Promise<unknown> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if ('token' in credential) headers.authorization = `Bearer ${credential.token}`;
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: 'cookie' in credential ? 'same-origin' : 'omit',
      cache: 'no-store',
      redirect: 'error',
      // A write needs its Origin header (the API checks it, ADR-M73 §2.3): with `no-referrer` and
      // a non-CORS mode the Fetch standard sends `Origin: null` (security review of U05 PR 2).
      referrerPolicy: method === 'GET' ? 'no-referrer' : 'same-origin',
      mode: 'same-origin',
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, 'network');
  }
  if (response.status === 204) return undefined;
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const envelope = errorEnvelopeSchema.safeParse(body);
    const code = envelope.success ? envelope.data.error.code : 'unexpected';
    // An expired or revoked token or session ends the tab's sign-in; the person signs in again.
    if (response.status === 401 && endsCurrentSignIn(credential)) session.signOut();
    throw new ApiError(response.status, code);
  }
  return body;
}

function endsCurrentSignIn(credential: Credential): boolean {
  if ('token' in credential) return session.token() === credential.token;
  if ('cookie' in credential) return session.cookie();
  return false;
}
