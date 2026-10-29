// `adlc doctor` (task V07 AC2–AC4): the pure checks, the health probe's failure names, and the
// command against a mocked API. Read only: GET requests only, never the token in the output, and
// every case of a missing login, a down API or a refused token gives a result instead of failing.
import { PLATFORM_VERSION } from '@sdlc/api-schemas';
import { catalogFor, placeholdersOf, t } from '@sdlc/messages';
import { describe, expect, it } from 'vitest';

import { meSchema, type Me } from '../../apps/cli/src/api/schemas.js';
import {
  CHECK_IDS,
  evaluate,
  TOKEN_WARNING_DAYS,
  type CheckResult,
  type DoctorFacts,
} from '../../apps/cli/src/commands/doctor/checks.js';
import { classifyFetchError, probeHealth } from '../../apps/cli/src/commands/doctor/probe.js';
import { EXIT, runCli, type CliContext } from '../../apps/cli/src/index.js';
import { meBody, TOKEN_ID, tokenBody } from './fixtures.js';
import { apiError, TOKEN, useHarness, type Harness, type Routes } from './harness.js';

const NOW = new Date('2026-10-12T00:00:00.000Z');
const URL_OK = 'https://sdlc.example.test';
const DAY = 86_400_000;

function me(overrides: Record<string, unknown> = {}): Me {
  return meSchema.parse({ ...meBody(), token_id: TOKEN_ID, ...overrides });
}

function facts(overrides: Partial<DoctorFacts> = {}): DoctorFacts {
  return {
    tlsVerificationOff: false,
    login: { source: 'saved', apiUrl: URL_OK },
    live: { ok: true },
    ready: { ok: true },
    me: { ok: true, value: me() },
    tokenExpiresAt: { ok: true, value: new Date(NOW.getTime() + 60 * DAY).toISOString() },
    cliVersion: PLATFORM_VERSION,
    now: NOW,
    ...overrides,
  };
}

const byId = (results: readonly CheckResult[]) =>
  Object.fromEntries(results.map((r) => [r.id, r])) as Record<string, CheckResult>;
const statuses = (results: readonly CheckResult[]) =>
  Object.fromEntries(results.map((r) => [r.id, r.status]));

describe('adlc doctor: the checks (pure)', () => {
  it('gives every check once, in a fixed order, all ok on a good login', () => {
    const results = evaluate(facts());
    expect(results.map((r) => r.id)).toEqual([...CHECK_IDS]);
    expect(results.every((r) => r.status === 'ok')).toBe(true);
    expect(results.every((r) => r.fix === undefined)).toBe(true);
  });

  it('every text and fix key exists, with exactly the parameters it uses', () => {
    const catalog = catalogFor('en') as Readonly<Record<string, string>>;
    const cases: DoctorFacts[] = [
      facts(),
      facts({ tlsVerificationOff: true }),
      facts({ login: { source: 'none' } }),
      facts({ login: { source: 'env', problem: 'env_incomplete' } }),
      facts({ login: { source: 'env', problem: 'url', url: 'insecure' } }),
      facts({
        login: { source: 'saved', problem: 'credentials', credentials: 'unsafe_mode', path: '/x' },
      }),
      facts({ live: { ok: false, failure: 'tls', tlsCode: 'CERT_HAS_EXPIRED' } }),
      facts({ ready: { ok: false, failure: 'http', status: 503 } }),
      facts({ me: { ok: false, failure: 'http', status: 401 } }),
      facts({ me: { ok: true, value: me({ roles: [], platform_version: '9.9.9' }) } }),
    ];
    for (const c of cases) {
      for (const r of evaluate(c)) {
        for (const text of [r.text, r.fix].filter((x) => x !== undefined)) {
          expect(Object.hasOwn(catalog, text.key)).toBe(true);
          const used = placeholdersOf(catalog[text.key] ?? '');
          for (const name of used) expect(Object.keys(text.params ?? {})).toContain(name);
        }
        if (r.status === 'warning' || r.status === 'failed') expect(r.fix).toBeDefined();
      }
    }
  });

  it('TLS checks off: fails and checks nothing else (no request is ever sent)', () => {
    const results = evaluate(facts({ tlsVerificationOff: true }));
    expect(results[0]).toMatchObject({ id: 'cli.tls_verification', status: 'failed' });
    expect(results.slice(1).every((r) => r.status === 'skipped')).toBe(true);
  });

  it('no login: fails with adlc login, and skips the API checks', () => {
    const r = byId(evaluate(facts({ login: { source: 'none' } })));
    expect(r['cli.api_url']).toMatchObject({
      status: 'failed',
      fix: { key: 'cli.doctor.fix.login' },
    });
    expect(r['cli.api_reachable']?.status).toBe('skipped');
    expect(r['cli.version']?.status).toBe('skipped');
  });

  it('an unsafe credentials file names the file and the chmod fix', () => {
    const r = byId(
      evaluate(
        facts({
          login: {
            source: 'saved',
            problem: 'credentials',
            credentials: 'unsafe_mode',
            path: '/h/c',
          },
        }),
      ),
    );
    expect(r['cli.credentials_file']).toMatchObject({
      status: 'failed',
      fix: { key: 'cli.credentials.unsafe_mode', params: { path: '/h/c' } },
    });
  });

  it('an environment login skips the file check', () => {
    const r = byId(evaluate(facts({ login: { source: 'env', apiUrl: URL_OK } })));
    expect(r['cli.credentials_file']?.status).toBe('skipped');
    expect(r['cli.api_url']?.text.key).toBe('cli.doctor.api_url_env');
  });

  it('an API that cannot be reached fails with the fix for its cause, and skips the rest', () => {
    const tls = evaluate(
      facts({ live: { ok: false, failure: 'tls', tlsCode: 'CERT_HAS_EXPIRED' } }),
    );
    expect(byId(tls)['cli.api_reachable']).toMatchObject({
      status: 'failed',
      text: { params: { code: 'CERT_HAS_EXPIRED' } },
      fix: { key: 'cli.doctor.fix.tls' },
    });
    expect(statuses(tls)).toMatchObject({
      'cli.api_ready': 'skipped',
      'cli.login': 'skipped',
      'cli.version': 'skipped',
    });
    // V09: an unknown CA (a company or throw-away CA behind the proxy) names NODE_EXTRA_CA_CERTS.
    const unknownCa = evaluate(
      facts({ live: { ok: false, failure: 'tls', tlsCode: 'SELF_SIGNED_CERT_IN_CHAIN' } }),
    );
    expect(byId(unknownCa)['cli.api_reachable']?.fix?.key).toBe('cli.doctor.fix.tls_ca');
    const refused = byId(evaluate(facts({ live: { ok: false, failure: 'refused' } })));
    expect(refused['cli.api_reachable']?.fix?.key).toBe('cli.doctor.fix.unreachable');
  });

  it('plain HTTP on loopback is a warning (AC2 asks for TLS)', () => {
    const r = byId(
      evaluate(facts({ login: { source: 'saved', apiUrl: 'http://127.0.0.1:8090' } })),
    );
    expect(r['cli.api_reachable']?.status).toBe('warning');
  });

  it('a database that is down is a warning; a refused token fails', () => {
    expect(
      byId(evaluate(facts({ ready: { ok: false, failure: 'http', status: 503 } })))['cli.api_ready']
        ?.status,
    ).toBe('warning');
    const refused = evaluate(facts({ me: { ok: false, failure: 'http', status: 401 } }));
    expect(byId(refused)['cli.login']).toMatchObject({
      status: 'failed',
      fix: { key: 'cli.doctor.fix.login' },
    });
    expect(byId(refused)['cli.roles']?.status).toBe('skipped');
  });

  it(`warns when the token ends within ${TOKEN_WARNING_DAYS} days or its end is unknown`, () => {
    const soon = new Date(NOW.getTime() + 5 * DAY).toISOString();
    const r = byId(evaluate(facts({ tokenExpiresAt: { ok: true, value: soon } })));
    expect(r['cli.token_expiry']).toMatchObject({
      status: 'warning',
      text: { params: { days: 5 } },
    });
    expect(
      byId(evaluate(facts({ tokenExpiresAt: { ok: true, value: null } })))['cli.token_expiry']
        ?.status,
    ).toBe('warning');
    const session = facts({ me: { ok: true, value: me({ token_id: null, auth: 'session' }) } });
    expect(byId(evaluate(session))['cli.token_expiry']?.status).toBe('skipped');
  });

  it('lists the roles per project; warns with no role; a tenant admin without roles is ok', () => {
    const two = me({
      roles: [
        { project: { id: meBody().tenant_id, slug: 'shop' }, role: 'person_b' },
        { project: { id: meBody().tenant_id, slug: 'shop' }, role: 'governance' },
      ],
    });
    expect(
      byId(evaluate(facts({ me: { ok: true, value: two } })))['cli.roles']?.text.params,
    ).toEqual({
      roles: 'shop (governance, person_b)',
    });
    const none = byId(evaluate(facts({ me: { ok: true, value: me({ roles: [] }) } })));
    expect(none['cli.roles']?.status).toBe('warning');
    const admin = me({ roles: [], tenant_admin: true });
    expect(byId(evaluate(facts({ me: { ok: true, value: admin } })))['cli.roles']?.status).toBe(
      'ok',
    );
  });

  it('compares the versions; an unknown or odd version is never put into a command', () => {
    const differs = byId(
      evaluate(facts({ me: { ok: true, value: me({ platform_version: '9.9.9' }) } })),
    );
    expect(differs['cli.version']).toMatchObject({
      status: 'warning',
      fix: { key: 'cli.doctor.fix.version', params: { api: '9.9.9' } },
    });
    for (const odd of [undefined, '1.0.0; rm -rf ~', '$(id)']) {
      const value = me(odd === undefined ? {} : { platform_version: odd });
      const r = byId(
        evaluate(
          facts({
            me: {
              ok: true,
              value: odd === undefined ? { ...value, platform_version: undefined } : value,
            },
          }),
        ),
      );
      expect(r['cli.version']).toMatchObject({
        status: 'warning',
        fix: { key: 'cli.doctor.fix.version_unknown' },
      });
    }
  });
});

describe('adlc doctor: the health probe', () => {
  const failing = (cause: Record<string, unknown>) =>
    Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), cause) });

  it.each([
    [
      { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' },
      { failure: 'tls', tlsCode: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' },
    ],
    [{ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }, { failure: 'tls' }],
    [{ code: 'ECONNREFUSED' }, { failure: 'refused' }],
    [{ code: 'ENOTFOUND' }, { failure: 'dns' }],
    [{ code: 'UND_ERR_CONNECT_TIMEOUT' }, { failure: 'timeout' }],
    [{ code: 'no such code with spaces' }, { failure: 'network' }],
  ])('names a fetch failure with cause %o', (cause, expected) => {
    expect(classifyFetchError(failing(cause))).toMatchObject({ ok: false, ...expected });
  });

  it('a time-out and a redirect', async () => {
    expect(classifyFetchError(Object.assign(new Error('t'), { name: 'TimeoutError' }))).toEqual({
      ok: false,
      failure: 'timeout',
    });
    const redirect = (() => Promise.resolve(new Response(null, { status: 302 }))) as typeof fetch;
    expect(await probeHealth(redirect, URL_OK, 'live')).toEqual({
      ok: false,
      failure: 'redirect',
      status: 302,
    });
  });

  it('sends no token and never follows a redirect', async () => {
    const seen: RequestInit[] = [];
    const record = ((_url: URL, init: RequestInit) => {
      seen.push(init);
      return Promise.resolve(new Response('{"status":"ok"}', { status: 200 }));
    }) as unknown as typeof fetch;
    expect(await probeHealth(record, URL_OK, 'ready')).toEqual({ ok: true });
    expect(seen[0]?.redirect).toBe('manual');
    expect(JSON.stringify(seen[0]?.headers)).not.toMatch(/authorization/i);
  });
});

describe('adlc doctor: the command', () => {
  const harness = useHarness();
  const later = (days: number) => new Date(Date.now() + days * DAY);

  function goodRoutes(extra: Routes = {}): Routes {
    return {
      'GET /health/live': { status: 200, body: { status: 'ok' } },
      'GET /health/ready': { status: 200, body: { status: 'ok' } },
      'GET /v1/me': { status: 200, body: { ...meBody(), token_id: TOKEN_ID } },
      'GET /v1/me/tokens': {
        status: 200,
        body: { items: [tokenBody({ expires_at: later(60) })] },
      },
      ...extra,
    };
  }

  const noToken = (h: Harness) => {
    expect([...h.out, ...h.err].join('\n')).not.toContain(TOKEN);
  };

  it('all ok: one line per check, exit 0, GET requests only', async () => {
    const h = await harness({ routes: goodRoutes() });
    expect(await h.run(['doctor'])).toBe(EXIT.ok);
    expect(h.out[0]).toBe(t('cli.doctor.header', { version: PLATFORM_VERSION }));
    for (const id of CHECK_IDS) expect(h.out.some((line) => line.includes(`${id}:`))).toBe(true);
    expect(h.out.at(-1)).toBe(
      t('cli.doctor.summary', { ok: CHECK_IDS.length, warning: 0, failed: 0, skipped: 0 }),
    );
    expect(h.requests.every((r) => r.method === 'GET')).toBe(true);
    expect(h.requests.map((r) => r.url.pathname)).toEqual([
      '/health/live',
      '/health/ready',
      '/v1/me',
      '/v1/me/tokens',
    ]);
    noToken(h);
  });

  it('--json gives every check with its status and fix', async () => {
    const h = await harness({
      routes: goodRoutes({
        'GET /v1/me': { status: 200, body: { ...meBody(), token_id: TOKEN_ID, roles: [] } },
      }),
    });
    expect(await h.run(['doctor', '--json'])).toBe(EXIT.ok);
    const body = JSON.parse(h.out.join('\n')) as {
      cli_version: string;
      checks: { id: string; status: string; fix?: string }[];
    };
    expect(body.cli_version).toBe(PLATFORM_VERSION);
    expect(body.checks.map((c) => c.id)).toEqual([...CHECK_IDS]);
    expect(body.checks.find((c) => c.id === 'cli.roles')).toMatchObject({
      status: 'warning',
      fix: t('cli.doctor.fix.roles'),
    });
    noToken(h);
  });

  it('not logged in: exit 1, no request', async () => {
    const h = await harness({ loggedIn: false, routes: goodRoutes() });
    expect(await h.run(['doctor'])).toBe(EXIT.failed);
    expect(h.requests).toEqual([]);
    expect(h.out.join('\n')).toContain(t('cli.doctor.fix.login'));
  });

  it('TLS checks turned off: exit 1, no request', async () => {
    const h = await harness({ env: { NODE_TLS_REJECT_UNAUTHORIZED: '0' }, routes: goodRoutes() });
    expect(await h.run(['doctor'])).toBe(EXIT.failed);
    expect(h.requests).toEqual([]);
  });

  it('the API is down: says so instead of failing (AC3), exit 1', async () => {
    const h = await harness({ routes: goodRoutes() });
    const down = (() =>
      Promise.reject(
        Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }),
        }),
      )) as typeof fetch;
    const ctx: CliContext = { ...h.ctx, api: { ...h.ctx.api!, fetch: down } };
    expect(await runCli(['doctor'], ctx)).toBe(EXIT.failed);
    expect(h.out.join('\n')).toContain(t('cli.doctor.failure.refused'));
    expect(h.out.join('\n')).toContain(t('cli.doctor.skipped.unreachable'));
    noToken(h);
  });

  it('a refused token: exit 1 with adlc login; a warning alone exits 0', async () => {
    const refused = await harness({
      routes: goodRoutes({ 'GET /v1/me': apiError(401, 'unauthorized') }),
    });
    expect(await refused.run(['doctor'])).toBe(EXIT.failed);
    expect(refused.out.join('\n')).toContain(t('cli.doctor.login_refused'));
    const soon = await harness({
      routes: goodRoutes({
        'GET /v1/me/tokens': {
          status: 200,
          body: { items: [tokenBody({ expires_at: later(3) })] },
        },
        'GET /health/ready': apiError(503, 'not_ready'),
      }),
    });
    expect(await soon.run(['doctor'])).toBe(EXIT.ok);
    expect(soon.out.join('\n')).toContain(t('cli.doctor.fix.token_renew'));
    expect(soon.out.join('\n')).toContain(t('cli.doctor.not_ready'));
  });

  it('an API without its version (before 0.1.2) is a warning', async () => {
    const body = { ...meBody(), token_id: TOKEN_ID } as Record<string, unknown>;
    delete body.platform_version;
    const h = await harness({ routes: goodRoutes({ 'GET /v1/me': { status: 200, body } }) });
    expect(await h.run(['doctor'])).toBe(EXIT.ok);
    expect(h.out.join('\n')).toContain(t('cli.doctor.version_unknown', { cli: PLATFORM_VERSION }));
  });

  it('refuses extra arguments with its usage', async () => {
    const h = await harness();
    expect(await h.run(['doctor', 'extra'])).toBe(EXIT.usage);
    expect(h.err).toEqual([t('cli.doctor.usage')]);
  });

  it('cli.usage names it', () => {
    expect(t('cli.usage')).toMatch(/^ {4}adlc doctor /m);
  });
});
