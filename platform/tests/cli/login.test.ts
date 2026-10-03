// `sdlc login|logout|whoami` against a mocked API (B04 AC1–AC3, design/ADR-M36 §2.1–§2.3).
import { chmod, stat } from 'node:fs/promises';

import { t } from '@sdlc/messages';
import { describe, expect, it } from 'vitest';

import { EXIT } from '../../apps/cli/src/index.js';
import { credentialsPath, readSavedLogin } from '../../apps/cli/src/credentials/store.js';
import { meBody, PROJECT, TENANT, tokenBody } from './fixtures.js';
import { API_URL, apiError, TOKEN, useHarness } from './harness.js';

const harness = useHarness();
const ME = { 'GET /v1/me': { status: 200, body: meBody() } };

describe('sdlc login', () => {
  it('reads the token from a hidden prompt, checks it with /v1/me and saves it (mode 600)', async () => {
    const h = await harness({ routes: ME, loggedIn: false, tty: true, hidden: `${TOKEN}\n` });
    expect(await h.run(['login', '--api-url', `${API_URL}/`])).toBe(EXIT.ok);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.url.href).toBe(`${API_URL}/v1/me`);
    expect(h.requests[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(await readSavedLogin(h.ctx.env)).toEqual({ apiUrl: API_URL, token: TOKEN });
    expect((await stat(credentialsPath(h.ctx.env))).mode & 0o777).toBe(0o600);
    expect(h.out).toEqual([
      t('cli.login.done', {
        name: 'Harry',
        email: 'harry@example.test',
        tenant: TENANT,
        api_url: API_URL,
        path: credentialsPath(h.ctx.env),
      }),
      t('cli.whoami.role', { project: PROJECT.slug, role: 'person_a' }),
    ]);
    expect(h.err).toEqual([]);
  });

  it('reads the token from standard input with --token-stdin', async () => {
    const h = await harness({ routes: ME, loggedIn: false, stdin: `  ${TOKEN}  \n` });
    expect(await h.run(['login', '--api-url', API_URL, '--token-stdin', '--json'])).toBe(EXIT.ok);
    const json = JSON.parse(h.out.join('\n')) as Record<string, unknown>;
    expect(json).toMatchObject({ api_url: API_URL, tenant_id: TENANT });
    expect(json).not.toHaveProperty('token');
    expect(json).not.toHaveProperty('token_id');
  });

  it('refuses --token-stdin on a terminal, where the token would be shown', async () => {
    const h = await harness({ routes: ME, loggedIn: false, tty: true, stdin: TOKEN });
    expect(await h.run(['login', '--api-url', API_URL, '--token-stdin'])).toBe(EXIT.usage);
    expect(h.err).toEqual([t('cli.login.stdin_is_terminal')]);
    expect(h.requests).toEqual([]);
  });

  it('reuses the saved address when --api-url is left out', async () => {
    const h = await harness({ routes: ME, tty: true, hidden: TOKEN });
    expect(await h.run(['login'])).toBe(EXIT.ok);
    expect(h.requests[0]?.url.origin).toBe(API_URL);
  });

  it('needs an address the first time', async () => {
    const h = await harness({ routes: ME, loggedIn: false, tty: true, hidden: TOKEN });
    expect(await h.run(['login'])).toBe(EXIT.usage);
    expect(h.err).toEqual([t('cli.login.url_required')]);
  });

  it('refuses to read a token from a pipe without --token-stdin', async () => {
    const h = await harness({ routes: ME, loggedIn: false, tty: false, stdin: TOKEN });
    expect(await h.run(['login', '--api-url', API_URL])).toBe(EXIT.usage);
    expect(h.err).toEqual([t('cli.login.no_terminal')]);
    expect(h.requests).toEqual([]);
  });

  it('never echoes a wrong token and sends nothing', async () => {
    const secret = 'ghp_somethingSecretLooking1234567890';
    const h = await harness({ routes: ME, loggedIn: false, tty: true, hidden: secret });
    expect(await h.run(['login', '--api-url', API_URL])).toBe(EXIT.usage);
    expect(h.err).toEqual([t('cli.login.token_invalid')]);
    expect([...h.out, ...h.err].join('\n')).not.toContain(secret);
    expect(h.requests).toEqual([]);
  });

  it('saves nothing when the API refuses the token (exit 4)', async () => {
    const h = await harness({
      routes: { 'GET /v1/me': apiError(401, 'unauthorized') },
      loggedIn: false,
      tty: true,
      hidden: TOKEN,
    });
    expect(await h.run(['login', '--api-url', API_URL])).toBe(EXIT.auth);
    expect(await readSavedLogin(h.ctx.env)).toBeUndefined();
    expect(h.err).toEqual([
      t('cli.api.refused', { code: 'unauthorized', message: t('api.error.unauthorized') }),
      t('cli.api.login_again'),
    ]);
  });

  it.each([
    ['http://sdlc.example.test', 'cli.api_url.insecure'],
    ['https://u:p@sdlc.example.test', 'cli.api_url.credentials'],
    ['https://sdlc.example.test?x=1', 'cli.api_url.query'],
    ['nonsense', 'cli.api_url.invalid'],
  ] as const)('refuses the address %s before asking for the token', async (url, key) => {
    const h = await harness({ routes: ME, loggedIn: false, tty: true, hidden: TOKEN });
    expect(await h.run(['login', '--api-url', url])).toBe(EXIT.usage);
    expect(h.err).toEqual([t(key)]);
    expect(h.requests).toEqual([]);
  });

  it('accepts http:// on this machine', async () => {
    const h = await harness({ routes: ME, loggedIn: false, tty: true, hidden: TOKEN });
    expect(await h.run(['login', '--api-url', 'http://127.0.0.1:8090'])).toBe(EXIT.ok);
    expect(h.requests[0]?.url.href).toBe('http://127.0.0.1:8090/v1/me');
  });

  it('refuses to run with TLS verification turned off', async () => {
    const h = await harness({
      routes: ME,
      loggedIn: false,
      tty: true,
      hidden: TOKEN,
      env: { NODE_TLS_REJECT_UNAUTHORIZED: '0' },
    });
    expect(await h.run(['login', '--api-url', API_URL])).toBe(EXIT.usage);
    expect(h.err).toEqual([t('cli.tls_disabled')]);
    expect(h.requests).toEqual([]);
  });

  it('takes no token argument', async () => {
    const h = await harness({ routes: ME, loggedIn: false });
    expect(await h.run(['login', '--api-url', API_URL, '--token', TOKEN])).toBe(EXIT.usage);
    expect(h.err).toEqual([t('cli.login.usage')]);
    expect(h.err.join('\n')).not.toContain(TOKEN);
  });

  it('notes that SDLC_API_TOKEN overrides the saved login', async () => {
    const h = await harness({
      routes: ME,
      loggedIn: false,
      tty: true,
      hidden: TOKEN,
      env: { SDLC_API_TOKEN: TOKEN },
    });
    expect(await h.run(['login', '--api-url', API_URL])).toBe(EXIT.ok);
    expect(h.err).toEqual([t('cli.login.env_overrides')]);
  });
});

describe('sdlc logout', () => {
  // B13 (ADR-M36 §4, ADR-M37 §2.8): the token is revoked on the server first.
  it('revokes the token on the server, then deletes the saved login', async () => {
    const h = await harness({
      routes: { 'DELETE /v1/me/tokens/current': { status: 200, body: tokenBody() } },
    });
    expect(await h.run(['logout'])).toBe(EXIT.ok);
    expect(h.requests.map((r) => [r.method, r.url.pathname, r.headers.authorization])).toEqual([
      ['DELETE', '/v1/me/tokens/current', `Bearer ${TOKEN}`],
    ]);
    expect(h.out).toEqual([t('cli.logout.done')]);
    expect(await readSavedLogin(h.ctx.env)).toBeUndefined();
  });

  it('treats a token the server already refuses (401) as revoked', async () => {
    const h = await harness({
      routes: { 'DELETE /v1/me/tokens/current': apiError(401, 'unauthorized') },
    });
    expect(await h.run(['logout', '--json'])).toBe(EXIT.ok);
    expect(JSON.parse(h.out.join('\n'))).toEqual({ deleted: true, token_revoked: true });
  });

  it('still deletes the saved login when the server cannot revoke, and says so', async () => {
    const h = await harness({
      routes: { 'DELETE /v1/me/tokens/current': apiError(500, 'internal') },
    });
    expect(await h.run(['logout'])).toBe(EXIT.ok);
    expect(h.out).toEqual([t('cli.logout.not_revoked')]);
    expect(await readSavedLogin(h.ctx.env)).toBeUndefined();
  });

  it('says when there is nothing to delete', async () => {
    const h = await harness({ loggedIn: false });
    expect(await h.run(['logout', '--json'])).toBe(EXIT.ok);
    expect(JSON.parse(h.out.join('\n'))).toEqual({ deleted: false, token_revoked: false });
  });
});

describe('sdlc whoami and the login sources', () => {
  it('shows the user and roles with the saved login', async () => {
    const h = await harness({ routes: ME });
    expect(await h.run(['whoami'])).toBe(EXIT.ok);
    expect(h.out[0]).toBe(
      t('cli.whoami.user', { name: 'Harry', email: 'harry@example.test', tenant: TENANT }),
    );
  });

  it('uses SDLC_API_URL and SDLC_API_TOKEN without a saved login (CI)', async () => {
    const other = `sdlc_pat_${'c'.repeat(43)}`;
    const h = await harness({
      routes: ME,
      loggedIn: false,
      env: { SDLC_API_URL: 'https://ci.example.test/', SDLC_API_TOKEN: other },
    });
    expect(await h.run(['whoami'])).toBe(EXIT.ok);
    expect(h.requests[0]?.url.href).toBe('https://ci.example.test/v1/me');
    expect(h.requests[0]?.headers.authorization).toBe(`Bearer ${other}`);
  });

  it.each([
    [{ SDLC_API_URL: API_URL }, 'cli.env.incomplete'],
    [{ SDLC_API_TOKEN: TOKEN }, 'cli.env.incomplete'],
    [{ SDLC_API_URL: API_URL, SDLC_API_TOKEN: 'nope' }, 'cli.env.token_invalid'],
    [{ SDLC_API_URL: 'http://remote.example.test', SDLC_API_TOKEN: TOKEN }, 'cli.api_url.insecure'],
  ] as const)('refuses an incomplete or bad environment %#', async (env, key) => {
    const h = await harness({ routes: ME, env });
    expect(await h.run(['whoami'])).toBe(EXIT.usage);
    expect(h.err).toEqual([t(key)]);
    expect(h.requests).toEqual([]);
  });

  it('asks for a login when there is none', async () => {
    const h = await harness({ routes: ME, loggedIn: false });
    expect(await h.run(['whoami'])).toBe(EXIT.usage);
    expect(h.err).toEqual([t('cli.not_logged_in')]);
  });

  it('refuses a saved login that others can read', async () => {
    const h = await harness({ routes: ME });
    const path = credentialsPath(h.ctx.env);
    await chmod(path, 0o644);
    expect(await h.run(['whoami'])).toBe(EXIT.usage);
    expect(h.err).toEqual([t('cli.credentials.unsafe_mode', { path })]);
    expect(h.requests).toEqual([]);
  });
});
