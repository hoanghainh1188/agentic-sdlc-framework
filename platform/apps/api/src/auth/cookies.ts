// The two cookies of the dashboard sign-in (task U05, design/ADR-M73 §2.2). Both are `__Host-`
// cookies: `Secure`, `Path=/`, no `Domain`, so only this origin can set or read them. Their values
// are random secrets: never logged.
//
// - `__Host-sdlc_oauth` (pre-login, about 10 minutes): a handle to the state and PKCE verifier the
//   api keeps for this browser. `SameSite=Lax`, because the redirect back from github.com is a
//   cross-site top-level navigation that never carries a `Strict` cookie.
// - `__Host-sdlc_session`: the session secret. `SameSite=Strict`.

export const OAUTH_COOKIE = '__Host-sdlc_oauth';
export const SESSION_COOKIE = '__Host-sdlc_session';

/** Cookie values the api sets: 32 random bytes, base64url. Anything else is ignored. */
const VALUE = /^[A-Za-z0-9_-]{43}$/;

/**
 * The value of one cookie of the `Cookie` header, when it appears exactly once and has the
 * expected shape. A cookie sent twice (for example a second one planted for a sub-path) is
 * treated as absent.
 */
export function readCookie(
  header: string | string[] | undefined,
  name: typeof OAUTH_COOKIE | typeof SESSION_COOKIE,
): string | undefined {
  if (typeof header !== 'string') return undefined;
  const values = header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));
  if (values.length !== 1) return undefined;
  const value = values[0]!;
  return VALUE.test(value) ? value : undefined;
}

/** True when the header names the cookie at all, valid or not (the guard refuses token + cookie). */
export function hasCookie(header: string | string[] | undefined, name: string): boolean {
  if (typeof header !== 'string') return false;
  return header.split(';').some((part) => part.trim().startsWith(`${name}=`));
}

export function oauthCookie(value: string, maxAgeSeconds: number): string {
  return `${OAUTH_COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${String(maxAgeSeconds)}`;
}

export function sessionCookie(value: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${String(maxAgeSeconds)}`;
}

/** Deletes a cookie: same attributes, empty value, `Max-Age=0`. */
export function clearCookie(name: typeof OAUTH_COOKIE | typeof SESSION_COOKIE): string {
  const sameSite = name === OAUTH_COOKIE ? 'Lax' : 'Strict';
  return `${name}=; HttpOnly; Secure; SameSite=${sameSite}; Path=/; Max-Age=0`;
}
