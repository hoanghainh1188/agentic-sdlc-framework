// The numeric GitHub account ID of a login, for `adlc admin project apply` (task V17 AC2). The login
// is only a help at setup time: the platform matches people by the numeric ID (R037). The lookup
// is the public `GET /users/<login>` of the GitHub API, without a token; TLS checks stay on and a
// redirect (a renamed login) is refused, so the operator always confirms the ID of the login typed.
import { z } from 'zod';

import { segment } from '../../api/session.js';

/** `SDLC_GITHUB_API_URL` for GitHub Enterprise Server; default github.com. */
export const GITHUB_API_URL_ENV = 'SDLC_GITHUB_API_URL';
const DEFAULT_GITHUB_API_URL = 'https://api.github.com';
const LOOKUP_TIMEOUT_MS = 15_000;
const MAX_ANSWER_BYTES = 64 * 1024;

const userSchema = z.object({
  id: z.number().int().positive(),
  login: z.string().max(39),
  type: z.string().max(40),
});

export type GithubLookup =
  | { readonly kind: 'found'; readonly id: string; readonly login: string }
  | { readonly kind: 'unknown' }
  /** A bot account never decides (R037). */
  | { readonly kind: 'not_a_person' }
  | { readonly kind: 'failed' };

/** The GitHub API address: `https://` only (a plain `http://` would expose the lookup). */
export function githubApiUrl(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const raw = env[GITHUB_API_URL_ENV] ?? DEFAULT_GITHUB_API_URL;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return undefined;
    return url.href.replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}

export async function lookupGithubLogin(
  fetcher: typeof fetch,
  baseUrl: string,
  login: string,
): Promise<GithubLookup> {
  let response: Response;
  try {
    response = await fetcher(new URL(`${baseUrl}/users/${segment(login)}`), {
      method: 'GET',
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'sdlc-cli' },
      redirect: 'manual',
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
  } catch {
    return { kind: 'failed' };
  }
  if (response.status === 404) {
    await response.body?.cancel().catch(() => undefined);
    return { kind: 'unknown' };
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    return { kind: 'failed' };
  }
  const text = await response.text().catch(() => '');
  if (text === '' || text.length > MAX_ANSWER_BYTES) return { kind: 'failed' };
  let parsed: ReturnType<typeof userSchema.safeParse>;
  try {
    parsed = userSchema.safeParse(JSON.parse(text));
  } catch {
    return { kind: 'failed' };
  }
  if (!parsed.success) return { kind: 'failed' };
  if (parsed.data.login.toLowerCase() !== login.toLowerCase()) return { kind: 'failed' };
  if (parsed.data.type !== 'User') return { kind: 'not_a_person' };
  return { kind: 'found', id: String(parsed.data.id), login: parsed.data.login };
}
