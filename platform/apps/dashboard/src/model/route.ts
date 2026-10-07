// Routes live in the URL hash, so the api serves one page and a link can be shared: filters and
// the active screen are in the URL (never the token). Pure: no DOM.

export type Route =
  | { readonly name: 'intents'; readonly query: URLSearchParams }
  | { readonly name: 'intent'; readonly code: string; readonly query: URLSearchParams }
  | { readonly name: 'escalations'; readonly query: URLSearchParams }
  | { readonly name: 'numbers'; readonly query: URLSearchParams }
  | { readonly name: 'audit'; readonly query: URLSearchParams };

const INTENT_CODE = /^INT-[0-9]{4}-[0-9]{4,}$/;

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, '');
  const [pathPart = '', search = ''] = raw.split('?', 2);
  const query = new URLSearchParams(search);
  const parts = pathPart.split('/').filter((p) => p !== '');
  if (parts[0] === 'intents' && parts[1] !== undefined && INTENT_CODE.test(parts[1])) {
    return { name: 'intent', code: parts[1], query };
  }
  if (parts[0] === 'escalations') return { name: 'escalations', query };
  if (parts[0] === 'numbers') return { name: 'numbers', query };
  if (parts[0] === 'audit') return { name: 'audit', query };
  return { name: 'intents', query };
}

/** The route of one intent; the board when the code is not an intent code. */
export function intentHref(code: string): string {
  return INTENT_CODE.test(code) ? `#/intents/${code}` : '#/intents';
}

export function href(
  path: string,
  query: Readonly<Record<string, string | undefined>> = {},
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value) params.set(key, value);
  const search = params.toString();
  return `#/${path}${search ? `?${search}` : ''}`;
}
