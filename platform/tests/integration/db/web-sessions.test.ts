// D-08 U05 on a live PostgreSQL, through the Nest app and Fastify `inject()` (no port), with a fake
// GitHub sign-in provider: the OAuth start and callback (state, PKCE, the pre-login cookie, one
// refusal for every cause), the session cookie and its row (hashes only), the guard (token or
// cookie, never both; since U06 writes only to marked routes, with the CSRF token), the timeouts, sign out, sign out everywhere, the
// tenant admin's sign-out, the ends at disable and unlink, tenant isolation, the trigger, and no
// secret in logs, audit or tables (design/ADR-M73 §2.2, QUESTIONS #385–#389).
import { createHash } from 'node:crypto';

import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  WebSignInError,
  type RedactedSecret,
  type WebSignInProvider,
} from '../../../packages/contracts/src/index.js';
import { createApp, type ApiDeps } from '../../../apps/api/src/app.js';
import type { WebSignInSettings } from '../../../apps/api/src/settings.js';
import { bootstrapTenant } from '../../../packages/core/src/admin/bootstrap.js';
import { setUserActive, unlinkIdentity } from '../../../packages/core/src/admin/users.js';
import { issueApiToken } from '../../../packages/core/src/admin/tokens.js';
import { parseTenantId } from '../../../packages/core/src/db/tenant-id.js';
import { deriveCsrfToken } from '../../../packages/core/src/web-sessions/index.js';
import type { TenantScope } from '../../../packages/core/src/db/tenant-scope.js';
import { createJsonLogger } from '../../../packages/core/src/observability/index.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

type App = Awaited<ReturnType<typeof createApp>>;
const asApiDb = (db: TestDatabase): ApiDeps['db'] => db.app as unknown as ApiDeps['db'];
const START = new Date(Math.floor(Date.now() / 1000) * 1000);
const MIN = 60_000;
const ORIGIN = 'http://localhost:8090';

const SETTINGS: WebSignInSettings = {
  publicOrigin: ORIGIN,
  callbackUrl: `${ORIGIN}/v1/auth/github/callback`,
  githubWebUrl: 'https://github.com',
  githubApiUrl: 'https://api.github.com',
  oauthSecretPath: 'api/github-oauth',
  idleMs: 30 * MIN,
  maxAgeMs: 8 * 60 * MIN,
};

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const s256 = (value: string): string => createHash('sha256').update(value).digest('base64url');

class Token implements RedactedSecret {
  constructor(private readonly value: string) {}
  reveal(): string {
    return this.value;
  }
  toString(): string {
    return '[redacted]';
  }
  toJSON(): string {
    return '[redacted]';
  }
}

/** A fake GitHub: each code maps to an account ID; it checks the PKCE verifier like GitHub. */
class FakeGitHub implements WebSignInProvider {
  readonly codes = new Map<string, string>();
  readonly challenges = new Map<string, string>();
  readonly exchanged: string[] = [];
  readonly revoked: string[] = [];
  readonly issued: string[] = [];
  failExchange: WebSignInError | undefined;

  authorizeUrl(input: {
    state: string;
    codeChallenge: string;
    redirectUri: string;
  }): Promise<string> {
    this.challenges.set(input.state, input.codeChallenge);
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('state', input.state);
    url.searchParams.set('code_challenge', input.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('redirect_uri', input.redirectUri);
    return Promise.resolve(url.toString());
  }

  /** What GitHub does when the person approves: a code bound to the challenge of `state`. */
  approve(state: string, accountId: string): string {
    const code = `code${String(this.codes.size)}x${accountId}`;
    this.codes.set(code, `${accountId}|${this.challenges.get(state) ?? ''}`);
    return code;
  }

  exchangeCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<RedactedSecret> {
    this.exchanged.push(input.code);
    if (this.failExchange) return Promise.reject(this.failExchange);
    expect(input.redirectUri).toBe(SETTINGS.callbackUrl);
    const entry = this.codes.get(input.code);
    this.codes.delete(input.code);
    if (!entry) return Promise.reject(new WebSignInError('refused', 200));
    const [account, challenge] = entry.split('|');
    if (s256(input.codeVerifier) !== challenge) {
      return Promise.reject(new WebSignInError('refused', 200));
    }
    const token = `ghu_${'T'.repeat(20)}${account!}_${String(this.issued.length)}`;
    this.issued.push(token);
    return Promise.resolve(new Token(token));
  }

  accountId(token: RedactedSecret): Promise<string> {
    return Promise.resolve(/^ghu_T{20}(\d+)_\d+$/.exec(token.reveal())![1]!);
  }

  revokeToken(token: RedactedSecret): Promise<void> {
    this.revoked.push(token.reveal());
    return Promise.resolve();
  }
}

interface Reply {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | string[] | number | undefined>>;
  json(): Record<string, unknown> & { error?: { code: string } };
}

const cookiesOf = (reply: Reply): string[] => {
  const header = reply.headers['set-cookie'];
  return header === undefined ? [] : Array.isArray(header) ? header : [String(header)];
};
const cookieValue = (reply: Reply, name: string): string | undefined =>
  cookiesOf(reply)
    .find((c) => c.startsWith(`${name}=`))
    ?.split(';')[0]!
    .slice(name.length + 1);

describeDb('U05: dashboard sign-in with GitHub and sessions', () => {
  let t0: TestDatabase;
  let app: App;
  let off: App;
  let github: FakeGitHub;
  let clock = START;
  const lines: string[] = [];
  let acme: TenantScope;
  let other: TenantScope;
  let admin: { id: string; token: string };
  const people: Record<string, { id: string; identityId: string; github: string }> = {};

  const inject = async (
    target: App,
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    headers: Record<string, string> = {},
    payload?: Record<string, unknown>,
  ): Promise<Reply> =>
    await target
      .getHttpAdapter()
      .getInstance()
      .inject({ method, url, headers, ...(payload ? { payload } : {}) });

  /** The browser's whole sign-in. Returns the session secret, or the refusal redirect. */
  async function signIn(
    tenant: string,
    account: string,
    extraCookie = '',
  ): Promise<{ secret?: string; location: string }> {
    const start = await inject(app, 'GET', `/v1/auth/github/start?tenant=${tenant}`);
    expect(start.statusCode).toBe(302);
    const handle = cookieValue(start, '__Host-sdlc_oauth')!;
    const state = new URL(String(start.headers.location)).searchParams.get('state')!;
    const code = github.approve(state, account);
    const callback = await inject(
      app,
      'GET',
      `/v1/auth/github/callback?code=${code}&state=${state}`,
      { cookie: `__Host-sdlc_oauth=${handle}${extraCookie}` },
    );
    expect(callback.statusCode).toBe(302);
    const secret = cookieValue(callback, '__Host-sdlc_session');
    return { ...(secret ? { secret } : {}), location: String(callback.headers.location) };
  }

  const asSession = (secret: string, extra: Record<string, string> = {}) => ({
    cookie: `__Host-sdlc_session=${secret}`,
    ...extra,
  });

  async function person(scope: TenantScope, key: string, account: string) {
    const user = await scope.users.create({ display_name: key, email: `${key}@x.example.com` });
    const identity = await scope.userIdentities.link({
      user_id: user.id,
      provider: 'github',
      external_id: account,
      external_login: key,
    });
    return { id: user.id, identityId: identity.id, github: account };
  }

  beforeAll(async () => {
    t0 = await createTestDatabase();
    const boot = await bootstrapTenant(t0.app, {
      tenantSlug: 'acme',
      tenantName: 'Acme',
      adminEmail: 'admin@acme.example.com',
      adminName: 'Admin',
      now: START,
    });
    acme = t0.app.forTenant(parseTenantId(boot.tenant.id));
    admin = { id: boot.user.id, token: boot.token.token };
    const second = await bootstrapTenant(t0.app, {
      tenantSlug: 'globex',
      tenantName: 'Globex',
      adminEmail: 'admin@globex.example.com',
      adminName: 'Admin',
      now: START,
    });
    other = t0.app.forTenant(parseTenantId(second.tenant.id));
    people.alice = await person(acme, 'alice', '1001');
    people.bob = await person(acme, 'bob', '1002');
    people.carol = await person(acme, 'carol', '1003');
    people.dave = await person(acme, 'dave', '1004');
    people.erin = await person(acme, 'erin', '1005');
    // The same GitHub account linked in another tenant: a sign-in names the tenant.
    people.alice2 = await person(other, 'alice2', '1001');
    github = new FakeGitHub();
    const log = createJsonLogger({ write: (line) => lines.push(line) });
    const base = {
      db: asApiDb(t0),
      settings: { rateLimitPerMinute: 10_000, authFailuresPerMinute: 1000 },
      now: () => clock,
      logger: { error: (...args: unknown[]) => lines.push(args.map(String).join(' ')) },
      log,
    };
    app = await createApp({
      ...base,
      webSignIn: {
        settings: SETTINGS,
        provider: github,
        limits: { starts: 10_000, callbacks: 10_000 },
      },
    });
    off = await createApp(base);
  }, 60_000);

  beforeEach(() => {
    clock = new Date(clock.getTime() + MIN);
  });

  afterAll(async () => {
    await app?.close();
    await off?.close();
    await t0?.drop();
  });

  describe('the OAuth flow', () => {
    it('start: a pre-login cookie (Lax, 10 min) and a redirect with state and S256', async () => {
      const reply = await inject(app, 'GET', '/v1/auth/github/start?tenant=acme');
      expect(reply.statusCode).toBe(302);
      const location = new URL(String(reply.headers.location));
      expect(location.origin + location.pathname).toBe('https://github.com/login/oauth/authorize');
      expect(location.searchParams.get('code_challenge_method')).toBe('S256');
      expect(location.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(location.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const [cookie] = cookiesOf(reply);
      expect(cookie).toMatch(
        /^__Host-sdlc_oauth=[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=600$/,
      );
      // The cookie holds a handle, never the state.
      expect(cookie).not.toContain(location.searchParams.get('state')!);
      expect(reply.headers['cache-control']).toBe('no-store');
    });

    it('callback: a new session cookie (Strict), the row holds the hash only, the token is revoked', async () => {
      const revokedBefore = github.revoked.length;
      const { secret, location } = await signIn('acme', people.alice!.github);
      expect(location).toBe('/dashboard/');
      expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const rows = await sql<Record<string, unknown>>`
        SELECT * FROM web_sessions WHERE secret_sha256 = ${sha256(secret!)}`.execute(t0.owner);
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]).toMatchObject({ user_id: people.alice!.id, revoked_at: null });
      expect(JSON.stringify(rows.rows[0])).not.toContain(secret);
      expect(github.revoked.length).toBe(revokedBefore + 1);
      const me = await inject(app, 'GET', '/v1/me', asSession(secret!));
      expect(me.statusCode).toBe(200);
      expect(me.json()).toMatchObject({ auth: 'session', token_id: null });
      expect((me.json().user as { id: string }).id).toBe(people.alice!.id);
    });

    it('the session cookie has the __Host- attributes and lives as long as the session', async () => {
      const start = await inject(app, 'GET', '/v1/auth/github/start?tenant=acme');
      const handle = cookieValue(start, '__Host-sdlc_oauth')!;
      const state = new URL(String(start.headers.location)).searchParams.get('state')!;
      const code = github.approve(state, people.alice!.github);
      const reply = await inject(
        app,
        'GET',
        `/v1/auth/github/callback?code=${code}&state=${state}`,
        {
          cookie: `__Host-sdlc_oauth=${handle}`,
        },
      );
      const cookies = cookiesOf(reply);
      expect(cookies).toContain(
        '__Host-sdlc_oauth=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
      );
      expect(cookies.find((c) => c.startsWith('__Host-sdlc_session='))).toMatch(
        /; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=28800$/,
      );
    });

    it('login CSRF: the callback needs this browser’s pre-login cookie and the matching state', async () => {
      const a = await inject(app, 'GET', '/v1/auth/github/start?tenant=acme');
      const b = await inject(app, 'GET', '/v1/auth/github/start?tenant=acme');
      const handleA = cookieValue(a, '__Host-sdlc_oauth')!;
      const stateB = new URL(String(b.headers.location)).searchParams.get('state')!;
      const codeB = github.approve(stateB, people.alice!.github);
      const exchanged = github.exchanged.length;
      // No cookie (a link opened elsewhere), another browser's cookie, a wrong state.
      for (const headers of [
        {} as Record<string, string>,
        { cookie: `__Host-sdlc_oauth=${handleA}` },
      ]) {
        const reply = await inject(
          app,
          'GET',
          `/v1/auth/github/callback?code=${codeB}&state=${stateB}`,
          headers,
        );
        expect(reply.headers.location).toBe('/dashboard/?signin=refused');
        expect(cookieValue(reply, '__Host-sdlc_session')).toBeUndefined();
      }
      expect(github.exchanged.length).toBe(exchanged);
      // A wrong state does not use browser A's pending sign-in up (security review, LOW-1):
      // with its own state it still works.
      const stateA = new URL(String(a.headers.location)).searchParams.get('state')!;
      const codeA = github.approve(stateA, people.alice!.github);
      const own = await inject(
        app,
        'GET',
        `/v1/auth/github/callback?code=${codeA}&state=${stateA}`,
        {
          cookie: `__Host-sdlc_oauth=${handleA}`,
        },
      );
      expect(own.headers.location).toBe('/dashboard/');
    });

    it('a state is used once', async () => {
      const start = await inject(app, 'GET', '/v1/auth/github/start?tenant=acme');
      const handle = cookieValue(start, '__Host-sdlc_oauth')!;
      const state = new URL(String(start.headers.location)).searchParams.get('state')!;
      const code = github.approve(state, people.alice!.github);
      const url = `/v1/auth/github/callback?code=${code}&state=${state}`;
      const first = await inject(app, 'GET', url, { cookie: `__Host-sdlc_oauth=${handle}` });
      expect(first.headers.location).toBe('/dashboard/');
      const again = await inject(app, 'GET', url, { cookie: `__Host-sdlc_oauth=${handle}` });
      expect(again.headers.location).toBe('/dashboard/?signin=refused');
    });

    it('a pending sign-in expires after 10 minutes', async () => {
      const start = await inject(app, 'GET', '/v1/auth/github/start?tenant=acme');
      const handle = cookieValue(start, '__Host-sdlc_oauth')!;
      const state = new URL(String(start.headers.location)).searchParams.get('state')!;
      const code = github.approve(state, people.alice!.github);
      clock = new Date(clock.getTime() + 10 * MIN + 1000);
      const reply = await inject(
        app,
        'GET',
        `/v1/auth/github/callback?code=${code}&state=${state}`,
        {
          cookie: `__Host-sdlc_oauth=${handle}`,
        },
      );
      expect(reply.headers.location).toBe('/dashboard/?signin=refused');
    });

    it('one refusal whatever the cause: unknown tenant or account, unlinked, disabled, denied', async () => {
      expect((await signIn('nosuch', people.alice!.github)).location).toBe(
        '/dashboard/?signin=refused',
      );
      expect((await signIn('acme', '9999')).location).toBe('/dashboard/?signin=refused');
      // The account is linked in globex, not as this person in acme: each tenant is separate.
      expect((await signIn('globex', people.bob!.github)).location).toBe(
        '/dashboard/?signin=refused',
      );
      const start = await inject(app, 'GET', '/v1/auth/github/start?tenant=acme');
      const handle = cookieValue(start, '__Host-sdlc_oauth')!;
      const state = new URL(String(start.headers.location)).searchParams.get('state')!;
      const denied = await inject(
        app,
        'GET',
        `/v1/auth/github/callback?error=access_denied&state=${state}`,
        { cookie: `__Host-sdlc_oauth=${handle}` },
      );
      expect(denied.headers.location).toBe('/dashboard/?signin=refused');
      expect(lines.join('\n')).toContain('"cause":"no_linked_user"');
    });

    it('signs in to the tenant the person chose', async () => {
      const { secret } = await signIn('globex', people.alice2!.github);
      const me = await inject(app, 'GET', '/v1/me', asSession(secret!));
      expect(me.json().tenant_id).toBe(other.tenantId);
    });

    it('GitHub unreachable: `unavailable`, no session', async () => {
      github.failExchange = new WebSignInError('unavailable');
      try {
        const { secret, location } = await signIn('acme', people.alice!.github);
        expect(location).toBe('/dashboard/?signin=unavailable');
        expect(secret).toBeUndefined();
      } finally {
        github.failExchange = undefined;
      }
    });

    it('no fixation: a session cookie sent to the callback is ended (replaced), never reused', async () => {
      const first = await signIn('acme', people.carol!.github);
      const second = await signIn(
        'acme',
        people.carol!.github,
        `; __Host-sdlc_session=${first.secret!}`,
      );
      expect(second.secret).not.toBe(first.secret);
      expect((await inject(app, 'GET', '/v1/me', asSession(first.secret!))).statusCode).toBe(401);
      expect((await inject(app, 'GET', '/v1/me', asSession(second.secret!))).statusCode).toBe(200);
      const ended = await sql<{ end_reason: string }>`
        SELECT end_reason FROM web_sessions WHERE secret_sha256 = ${sha256(first.secret!)}`.execute(
        t0.owner,
      );
      expect(ended.rows[0]?.end_reason).toBe('replaced');
    });
  });

  describe('the guard', () => {
    let secret: string;
    beforeAll(async () => {
      secret = (await signIn('acme', people.alice!.github)).secret!;
    });

    it('refuses a token and a session cookie together', async () => {
      const reply = await inject(app, 'GET', '/v1/me', {
        ...asSession(secret),
        authorization: `Bearer ${admin.token}`,
      });
      expect(reply.statusCode).toBe(400);
      expect(reply.json().error?.code).toBe('credentials_ambiguous');
    });

    it('a session writes only to marked routes: every other write is refused, even from the origin (U06)', async () => {
      for (const [method, url] of [
        ['POST', '/v1/intents'],
        ['POST', '/v1/me/tokens'],
        ['DELETE', '/v1/me/tokens/current'],
        ['POST', '/v1/runs/00000000-0000-4000-8000-000000000000/kill'],
      ] as const) {
        const reply = await inject(
          app,
          method,
          url,
          asSession(secret, {
            origin: ORIGIN,
            'sec-fetch-site': 'same-origin',
            'x-sdlc-csrf': deriveCsrfToken(secret),
          }),
          {},
        );
        expect(reply.statusCode, url).toBe(403);
        expect(reply.json().error?.code, url).toBe('session_write_not_allowed');
      }
    });

    it('sign-out needs the public origin and the CSRF token (U06), then ends the session and clears the cookie', async () => {
      const own = (await signIn('acme', people.alice!.github)).secret!;
      for (const headers of [
        {} as Record<string, string>,
        { origin: 'http://evil.example' },
        { origin: ORIGIN, 'sec-fetch-site': 'cross-site', 'x-sdlc-csrf': deriveCsrfToken(own) },
        { origin: ORIGIN },
      ]) {
        const reply = await inject(app, 'POST', '/v1/auth/sign-out', asSession(own, headers));
        expect(reply.statusCode).toBe(403);
      }
      const reply = await inject(
        app,
        'POST',
        '/v1/auth/sign-out',
        asSession(own, { origin: ORIGIN, 'x-sdlc-csrf': deriveCsrfToken(own) }),
      );
      expect(reply.statusCode).toBe(204);
      expect(cookiesOf(reply)).toContain(
        '__Host-sdlc_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0',
      );
      const after = await inject(app, 'GET', '/v1/me', asSession(own));
      expect(after.statusCode).toBe(401);
      expect(after.json().error?.code).toBe('session_ended');
    });

    it('ends after 30 idle minutes', async () => {
      const own = (await signIn('acme', people.alice!.github)).secret!;
      clock = new Date(clock.getTime() + 29 * MIN);
      expect((await inject(app, 'GET', '/v1/me', asSession(own))).statusCode).toBe(200);
      clock = new Date(clock.getTime() + 31 * MIN);
      expect((await inject(app, 'GET', '/v1/me', asSession(own))).statusCode).toBe(401);
    });

    it('ends after 8 hours, even when used', async () => {
      const own = (await signIn('acme', people.alice!.github)).secret!;
      for (let i = 0; i < 23; i += 1) {
        clock = new Date(clock.getTime() + 20 * MIN);
        expect((await inject(app, 'GET', '/v1/me', asSession(own))).statusCode, String(i)).toBe(
          200,
        );
      }
      clock = new Date(clock.getTime() + 21 * MIN);
      expect((await inject(app, 'GET', '/v1/me', asSession(own))).statusCode).toBe(401);
    });

    it('an ended or unknown cookie: 401 session_ended, and the cookie is deleted (review, MEDIUM-2)', async () => {
      for (const value of ['short', 'A'.repeat(43)]) {
        const reply = await inject(app, 'GET', '/v1/me', asSession(value));
        expect(reply.statusCode).toBe(401);
        expect(reply.json().error?.code).toBe('session_ended');
        expect(cookiesOf(reply)).toContain(
          '__Host-sdlc_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0',
        );
      }
    });

    it('start and callback are limited per address (20 and 30 a minute by default)', async () => {
      const limited = await createApp({
        db: asApiDb(t0),
        settings: { rateLimitPerMinute: 10_000, authFailuresPerMinute: 1000 },
        now: () => clock,
        logger: { error: () => undefined },
        log: createJsonLogger({ write: () => undefined }),
        webSignIn: { settings: SETTINGS, provider: github, limits: { starts: 2, callbacks: 1 } },
      });
      try {
        const statuses = [];
        for (let i = 0; i < 3; i += 1) {
          statuses.push(
            (await inject(limited, 'GET', '/v1/auth/github/start?tenant=acme')).statusCode,
          );
        }
        expect(statuses).toEqual([302, 302, 429]);
        const callbacks = [];
        for (let i = 0; i < 2; i += 1) {
          callbacks.push((await inject(limited, 'GET', '/v1/auth/github/callback')).statusCode);
        }
        expect(callbacks).toEqual([302, 429]);
      } finally {
        await limited.close();
      }
    });

    it('a stale cookie never blocks the address: many ended-session requests, then a token works', async () => {
      const limited = await createApp({
        db: asApiDb(t0),
        settings: { rateLimitPerMinute: 10_000, authFailuresPerMinute: 3 },
        now: () => clock,
        logger: { error: () => undefined },
        log: createJsonLogger({ write: () => undefined }),
        webSignIn: { settings: SETTINGS, provider: github },
      });
      try {
        for (let i = 0; i < 10; i += 1) {
          expect(
            (await inject(limited, 'GET', '/v1/me', asSession('B'.repeat(43)))).statusCode,
          ).toBe(401);
        }
        const me = await inject(limited, 'GET', '/v1/me', {
          authorization: `Bearer ${admin.token}`,
        });
        expect(me.statusCode).toBe(200);
      } finally {
        await limited.close();
      }
    });

    it('with sign-in off, a session cookie is ignored (no credential)', async () => {
      const reply = await inject(off, 'GET', '/v1/me', asSession(secret));
      expect(reply.statusCode).toBe(401);
      expect(reply.json().error?.code).toBe('unauthorized');
      expect((await inject(off, 'GET', '/v1/auth/github/start?tenant=acme')).statusCode).toBe(404);
      expect((await inject(off, 'GET', '/v1/auth/config')).json()).toEqual({
        github: false,
        actions: false,
      });
      expect((await inject(app, 'GET', '/v1/auth/config')).json()).toEqual({
        github: true,
        actions: false,
      });
    });
  });

  describe('ending sessions', () => {
    it('sign out everywhere ends every session of the caller only', async () => {
      const one = (await signIn('acme', people.bob!.github)).secret!;
      const two = (await signIn('acme', people.bob!.github)).secret!;
      const others = (await signIn('acme', people.alice!.github)).secret!;
      const reply = await inject(
        app,
        'DELETE',
        '/v1/me/sessions',
        asSession(one, { origin: ORIGIN, 'x-sdlc-csrf': deriveCsrfToken(one) }),
      );
      expect(reply.statusCode).toBe(200);
      expect(reply.json()).toEqual({ ended: 2 });
      for (const s of [one, two]) {
        expect((await inject(app, 'GET', '/v1/me', asSession(s))).statusCode).toBe(401);
      }
      expect((await inject(app, 'GET', '/v1/me', asSession(others))).statusCode).toBe(200);
    });

    it('a tenant admin signs a person out everywhere; nobody else may', async () => {
      const s = (await signIn('acme', people.dave!.github)).secret!;
      const refused = await inject(app, 'DELETE', `/v1/admin/users/${people.dave!.id}/sessions`, {
        authorization: `Bearer ${(await issueApiToken(acme, { userId: people.erin!.id, name: 'erin', now: clock })).token}`,
      });
      expect(refused.statusCode).toBe(403);
      const reply = await inject(app, 'DELETE', `/v1/admin/users/${people.dave!.id}/sessions`, {
        authorization: `Bearer ${admin.token}`,
      });
      expect(reply.json()).toEqual({ ended: 1 });
      expect((await inject(app, 'GET', '/v1/me', asSession(s))).statusCode).toBe(401);
    });

    it('disabling the user and unlinking the identity end the sessions', async () => {
      const disabled = (await signIn('acme', people.erin!.github)).secret!;
      await setUserActive(acme, { type: 'human', userId: admin.id }, people.erin!.id, false, clock);
      expect((await inject(app, 'GET', '/v1/me', asSession(disabled))).statusCode).toBe(401);
      await setUserActive(acme, { type: 'human', userId: admin.id }, people.erin!.id, true, clock);
      // Enabled again: the old session stays ended; a new sign-in works.
      expect((await inject(app, 'GET', '/v1/me', asSession(disabled))).statusCode).toBe(401);

      const unlinked = (await signIn('acme', people.erin!.github)).secret!;
      await unlinkIdentity(
        acme,
        { type: 'system' },
        people.erin!.id,
        people.erin!.identityId,
        clock,
      );
      expect((await inject(app, 'GET', '/v1/me', asSession(unlinked))).statusCode).toBe(401);
      expect((await signIn('acme', people.erin!.github)).location).toBe(
        '/dashboard/?signin=refused',
      );

      const reasons = await sql<{ end_reason: string }>`
        SELECT end_reason FROM web_sessions WHERE user_id = ${people.erin!.id} ORDER BY created_at`.execute(
        t0.owner,
      );
      expect(reasons.rows.map((r) => r.end_reason)).toEqual(['user_disabled', 'identity_unlinked']);
    });

    it('audits starts and ends with IDs and a reason only, never a session ID or a secret', async () => {
      const rows = await sql<{
        action: string;
        payload: Record<string, unknown>;
        entity_id: string;
      }>`
        SELECT action, payload, entity_id FROM audit_log
        WHERE action LIKE 'web_session.%' ORDER BY seq`.execute(t0.owner);
      const reasons = rows.rows
        .filter((r) => r.action === 'web_session.ended')
        .map((r) => r.payload.reason);
      expect(new Set(reasons)).toEqual(
        new Set(['replaced', 'sign_out', 'all', 'admin', 'user_disabled', 'identity_unlinked']),
      );
      expect(rows.rows.find((r) => r.action === 'web_session.started')?.payload).toEqual({
        provider: 'github',
      });
      const ids = await sql<{ id: string }>`SELECT id FROM web_sessions`.execute(t0.owner);
      const audit = JSON.stringify(rows.rows);
      for (const { id } of ids.rows) expect(audit).not.toContain(id);
    });
  });

  describe('isolation and the table', () => {
    it('a tenant scope never sees another tenant’s sessions', async () => {
      const own = await other.webSessions.listOpenForUser(people.alice!.id, clock);
      expect(own).toEqual([]);
      const theirs = await acme.webSessions.listOpenForUser(people.alice2!.id, clock);
      expect(theirs).toEqual([]);
    });

    it('platform_app may not delete sessions or change their fixed columns (SDA18)', async () => {
      const row = await sql<{ id: string }>`SELECT id FROM web_sessions LIMIT 1`.execute(t0.owner);
      const id = row.rows[0]!.id;
      await expect(
        sql`DELETE FROM web_sessions WHERE id = ${id}`.execute(t0.appRaw),
      ).rejects.toMatchObject({
        code: '42501',
      });
      await expect(
        sql`UPDATE web_sessions SET expires_at = expires_at + interval '1 day' WHERE id = ${id}`.execute(
          t0.appRaw,
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        sql`UPDATE web_sessions SET last_seen_at = created_at - interval '1 hour' WHERE id = ${id}`.execute(
          t0.owner,
        ),
      ).rejects.toMatchObject({ code: 'SDA18' });
    });

    it('no GitHub token, session secret or client secret in the logs', () => {
      const text = lines.join('\n');
      for (const token of github.issued) expect(text).not.toContain(token);
      expect(text).not.toMatch(/__Host-sdlc_session=[A-Za-z0-9_-]{43}/);
      expect(text).not.toMatch(/ghu_/);
      // Every token GitHub issued was revoked at once (QUESTIONS #388).
      expect(new Set(github.revoked)).toEqual(new Set(github.issued));
    });
  });
});
