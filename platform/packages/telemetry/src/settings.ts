// Tracing settings (design/ADR-M35 §2.4). One variable for every process: the OTLP/HTTP base URL
// of the collector (`http://otel-collector:4318`). Empty or unset: tracing is off, no SDK starts.

/** Environment variable of the OTLP endpoint, shared by the api, worker and runner. */
export const OTEL_ENDPOINT_ENV = 'SDLC_OTEL_ENDPOINT';

/**
 * Parses the endpoint. Returns `undefined` when tracing is off and `null` when the value is not
 * valid: an http(s) URL without user info, query or fragment (the collector needs no credentials,
 * so a value with a password is always a mistake).
 */
export function parseOtelEndpoint(value: string | undefined): string | undefined | null {
  const raw = value?.trim() ?? '';
  if (raw === '') return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    return null;
  }
  return url.toString().replace(/\/+$/, '');
}
