// The health probe of `adlc doctor`: `GET /health/live` or `/health/ready` without a token (both
// are public), with the same rules as the API client (TLS verified by Node, redirects refused, a
// time limit), and a failure named precisely enough to fix it: a TLS error keeps Node's error code
// (from a fixed form), never its message.
import type { Probe } from './checks.js';

export const PROBE_TIMEOUT_MS = 10_000;

const REFUSED = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH']);
const DNS = new Set(['ENOTFOUND', 'EAI_AGAIN']);
const TLS = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_REVOKED',
  'CERT_UNTRUSTED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** The error code of a failed `fetch` (undici puts the socket's error in `cause`). */
function codeOf(error: unknown): string | undefined {
  for (let e: unknown = error, depth = 0; e instanceof Error && depth < 4; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

export function classifyFetchError(error: unknown): Probe {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return { ok: false, failure: 'timeout' };
  }
  const code = codeOf(error);
  if (code === undefined) return { ok: false, failure: 'network' };
  if (TLS.has(code) || code.startsWith('ERR_SSL_') || code.startsWith('ERR_TLS_')) {
    return { ok: false, failure: 'tls', tlsCode: code };
  }
  if (REFUSED.has(code)) return { ok: false, failure: 'refused' };
  if (DNS.has(code)) return { ok: false, failure: 'dns' };
  if (code === 'UND_ERR_CONNECT_TIMEOUT') return { ok: false, failure: 'timeout' };
  return { ok: false, failure: 'network' };
}

export async function probeHealth(
  fetchFn: typeof fetch,
  apiUrl: string,
  which: 'live' | 'ready',
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<Probe> {
  let response: Response;
  try {
    response = await fetchFn(new URL(`${apiUrl}/health/${which}`), {
      method: 'GET',
      headers: { accept: 'application/json', 'user-agent': 'sdlc-cli' },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return classifyFetchError(error);
  }
  // The body is not needed: only the status counts.
  await response.body?.cancel().catch(() => undefined);
  if (response.status >= 300 && response.status < 400) {
    return { ok: false, failure: 'redirect', status: response.status };
  }
  if (response.status !== 200) return { ok: false, failure: 'http', status: response.status };
  return { ok: true };
}
