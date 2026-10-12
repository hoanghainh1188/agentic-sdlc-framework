// D-08 U05, design/ADR-M73 §2.2: the dashboard's GitHub sign-in client (`GitHubSignIn`) against a
// fake `fetch`: the authorize URL with PKCE S256, the code exchange with the client secret and the
// verifier, the numeric account ID, the token revoked with Basic authentication (QUESTIONS #388),
// error codes without GitHub's text, and the credentials read from OpenBao (never logged).
import { inspect } from 'node:util';

import { describe, expect, it } from 'vitest';

import { GitHubSignIn } from '../../packages/adapters/git-github/src/index.js';
import {
  WebSignInError,
  type RedactedSecret,
  type SecretEntry,
  type SecretReader,
} from '../../packages/contracts/src/index.js';

const CLIENT_ID = 'Iv23liFAKEFAKE';
// Built at run time, never a literal secret in the repository.
const CLIENT_SECRET = `cs${'0123456789abcdef'.repeat(2)}${String(Date.now() % 10)}`;
const USER_TOKEN = `ghu_${'A'.repeat(36)}`;

const secret = (value: string): RedactedSecret => ({ reveal: () => value });

function reader(
  fields: Record<string, Record<string, string>>,
): SecretReader & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    read(path: string): Promise<SecretEntry> {
      reads.push(path);
      const entry = fields[path];
      if (!entry) return Promise.reject(new Error('not found'));
      return Promise.resolve({
        version: 1,
        data: Object.fromEntries(Object.entries(entry).map(([k, v]) => [k, secret(v)])),
      });
    },
  };
}

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

function fakeFetch(answer: (call: Call) => Response): typeof fetch & { calls: Call[] } {
  const calls: Call[] = [];
  const impl = ((input: string | URL, init?: RequestInit) => {
    const call = { url: input.toString(), init: init ?? {} };
    calls.push(call);
    return Promise.resolve(answer(call));
  }) as typeof fetch & { calls: Call[] };
  impl.calls = calls;
  return impl;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const goodSecrets = () =>
  reader({
    'shared/github-app': { client_id: CLIENT_ID, private_key: 'x' },
    'api/github-oauth': { client_secret: CLIENT_SECRET },
  });

const client = (f: typeof fetch, secrets: SecretReader = goodSecrets()) =>
  new GitHubSignIn({ secrets, fetch: f });

describe('U05: GitHubSignIn', () => {
  it('builds the authorize URL with the client ID, S256 and no sign-up', async () => {
    const f = fakeFetch(() => json(500, {}));
    const url = new URL(
      await client(f).authorizeUrl({
        state: 's'.repeat(43),
        codeChallenge: 'c'.repeat(43),
        redirectUri: 'http://localhost:8090/v1/auth/github/callback',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT_ID,
      redirect_uri: 'http://localhost:8090/v1/auth/github/callback',
      state: 's'.repeat(43),
      code_challenge: 'c'.repeat(43),
      code_challenge_method: 'S256',
      allow_signup: 'false',
    });
    // The client secret never goes to the browser.
    expect(url.toString()).not.toContain(CLIENT_SECRET);
    expect(f.calls).toEqual([]);
  });

  it('exchanges the code with the secret and the verifier, no redirect followed', async () => {
    const f = fakeFetch(() => json(200, { access_token: USER_TOKEN, token_type: 'bearer' }));
    const token = await client(f).exchangeCode({
      code: 'code1',
      codeVerifier: 'v'.repeat(43),
      redirectUri: 'http://localhost:8090/v1/auth/github/callback',
    });
    expect(token.reveal()).toBe(USER_TOKEN);
    expect(`${token as unknown as string}`).toBe('[redacted]');
    expect(JSON.stringify({ token })).not.toContain(USER_TOKEN);
    expect(inspect(token)).not.toContain(USER_TOKEN);
    const [call] = f.calls;
    expect(call!.url).toBe('https://github.com/login/oauth/access_token');
    expect(call!.init.method).toBe('POST');
    expect(call!.init.redirect).toBe('error');
    expect(Object.fromEntries(new URLSearchParams(call!.init.body as string))).toEqual({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code: 'code1',
      code_verifier: 'v'.repeat(43),
      redirect_uri: 'http://localhost:8090/v1/auth/github/callback',
    });
  });

  it('a bad code or verifier (200 with `error`) is `refused`, without GitHub’s text', async () => {
    const f = fakeFetch(() =>
      json(200, { error: 'bad_verification_code', error_description: 'secret-ish text' }),
    );
    const failure = await client(f)
      .exchangeCode({ code: 'c', codeVerifier: 'v', redirectUri: 'r' })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(WebSignInError);
    expect(failure).toMatchObject({ code: 'refused', status: 200 });
    expect(String((failure as Error).message)).not.toContain('secret-ish');
  });

  it('server errors and network errors are `unavailable`; odd answers `bad_response`', async () => {
    const down = fakeFetch(() => json(502, {}));
    await expect(
      client(down).exchangeCode({ code: 'c', codeVerifier: 'v', redirectUri: 'r' }),
    ).rejects.toMatchObject({ code: 'unavailable' });
    const offline = (() =>
      Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch;
    await expect(client(offline).accountId(secret(USER_TOKEN))).rejects.toMatchObject({
      code: 'unavailable',
    });
    const odd = fakeFetch((call) =>
      call.init.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : json(200, { access_token: 'has space' }),
    );
    await expect(
      client(odd).exchangeCode({ code: 'c', codeVerifier: 'v', redirectUri: 'r' }),
    ).rejects.toMatchObject({ code: 'bad_response' });
    // A token in an odd shape is still revoked (security review, LOW-2).
    expect(odd.calls.map((c) => c.init.method)).toEqual(['POST', 'DELETE']);
    expect(JSON.parse(odd.calls[1]!.init.body as string)).toEqual({ access_token: 'has space' });
  });

  it('reads the numeric account ID with the person’s token', async () => {
    const f = fakeFetch(() => json(200, { id: 4242, login: 'someone' }));
    expect(await client(f).accountId(secret(USER_TOKEN))).toBe('4242');
    const headers = new Headers(f.calls[0]!.init.headers);
    expect(f.calls[0]!.url).toBe('https://api.github.com/user');
    expect(headers.get('authorization')).toBe(`Bearer ${USER_TOKEN}`);
    for (const id of ['4242', -1, 0, 1.5]) {
      const bad = fakeFetch(() => json(200, { id }));
      await expect(client(bad).accountId(secret(USER_TOKEN))).rejects.toMatchObject({
        code: 'bad_response',
      });
    }
    const refused = fakeFetch(() => json(401, {}));
    await expect(client(refused).accountId(secret(USER_TOKEN))).rejects.toMatchObject({
      code: 'refused',
    });
  });

  it('revokes the token with Basic client ID and secret; gone already counts as revoked', async () => {
    for (const status of [204, 404, 422]) {
      const f = fakeFetch(() => new Response(null, { status }));
      await client(f).revokeToken(secret(USER_TOKEN));
      const call = f.calls[0]!;
      expect(call.url).toBe(`https://api.github.com/applications/${CLIENT_ID}/token`);
      expect(call.init.method).toBe('DELETE');
      const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
      expect(new Headers(call.init.headers).get('authorization')).toBe(`Basic ${basic}`);
      expect(JSON.parse(call.init.body as string)).toEqual({ access_token: USER_TOKEN });
    }
    const down = fakeFetch(() => new Response(null, { status: 503 }));
    await expect(client(down).revokeToken(secret(USER_TOKEN))).rejects.toMatchObject({
      code: 'unavailable',
    });
  });

  it('a missing or malformed client secret makes every call `unavailable`', async () => {
    const f = fakeFetch(() => json(200, {}));
    for (const secrets of [
      reader({ 'shared/github-app': { client_id: CLIENT_ID } }),
      reader({
        'shared/github-app': { client_id: CLIENT_ID },
        'api/github-oauth': { client_secret: 'short' },
      }),
      reader({ 'api/github-oauth': { client_secret: CLIENT_SECRET } }),
    ]) {
      await expect(
        client(f, secrets).authorizeUrl({ state: 's', codeChallenge: 'c', redirectUri: 'r' }),
      ).rejects.toMatchObject({ code: 'unavailable' });
    }
    expect(f.calls).toEqual([]);
  });

  it('reads the credentials again after the cache time (a rotated secret needs no restart)', async () => {
    let now = 0;
    const secrets = goodSecrets();
    const c = new GitHubSignIn({
      secrets,
      fetch: fakeFetch(() => json(500, {})),
      now: () => new Date(now),
      cacheSeconds: 60,
    });
    const input = { state: 's', codeChallenge: 'c', redirectUri: 'r' };
    await c.authorizeUrl(input);
    await c.authorizeUrl(input);
    expect(secrets.reads).toHaveLength(2);
    now = 61_000;
    await c.authorizeUrl(input);
    expect(secrets.reads).toHaveLength(4);
  });

  it('refuses plain-http URLs unless the test switch is on', () => {
    expect(
      () => new GitHubSignIn({ secrets: goodSecrets(), webUrl: 'http://github.com' }),
    ).toThrow();
    expect(
      () =>
        new GitHubSignIn({
          secrets: goodSecrets(),
          apiUrl: 'http://127.0.0.1:1',
          allowPlaintext: true,
        }),
    ).not.toThrow();
  });
});
