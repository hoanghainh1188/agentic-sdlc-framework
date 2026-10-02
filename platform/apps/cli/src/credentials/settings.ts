// The API address and token rules (design/ADR-M36 §2.1, §2.3).

/** `sdlc_pat_` + 32 random bytes in base64url (ADR-M26 §2.3). */
export const API_TOKEN_PATTERN = /^sdlc_pat_[A-Za-z0-9_-]{43}$/;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export type UrlProblem = 'invalid' | 'insecure' | 'credentials' | 'query';

/**
 * Checks and normalises the API address. `https://` always; `http://` only on this machine
 * (loopback), where the Compose API listens on 127.0.0.1:8090. No user info, query or fragment.
 * Returns the address without a trailing slash, or the problem.
 */
export function normaliseApiUrl(value: string): { url: string } | { problem: UrlProblem } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { problem: 'invalid' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { problem: 'invalid' };
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) {
    return { problem: 'insecure' };
  }
  if (url.username !== '' || url.password !== '') return { problem: 'credentials' };
  if (url.search !== '' || url.hash !== '' || value.includes('?') || value.includes('#')) {
    return { problem: 'query' };
  }
  return { url: `${url.origin}${url.pathname.replace(/\/+$/, '')}` };
}

export function isApiToken(value: string): boolean {
  return API_TOKEN_PATTERN.test(value);
}
