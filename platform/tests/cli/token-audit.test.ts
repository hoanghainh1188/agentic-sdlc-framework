// `sdlc token …`, `sdlc admin token …` and `sdlc audit verify` over the API (B13 AC5, ADR-M37
// §2.8) against a mocked API. A new token is printed once, to stdout, never on stderr; a token
// issued for someone else says it must be replaced. The issued token is built at run time.
import { t } from '@sdlc/messages';
import { describe, expect, it } from 'vitest';

import { EXIT } from '../../apps/cli/src/index.js';
import { chainBody, issuedTokenBody, OTHER_USER, TOKEN_ID, tokenBody } from './fixtures.js';
import { TOKEN, useHarness } from './harness.js';

const harness = useHarness();
const NEW_TOKEN = `sdlc_pat_${'n'.repeat(40)}xyz`;

describe('sdlc token', () => {
  it('creates a token and prints it once, on stdout only', async () => {
    const h = await harness({
      routes: { 'POST /v1/me/tokens': { status: 201, body: issuedTokenBody(NEW_TOKEN) } },
    });
    expect(await h.run(['token', 'create', '--name', 'laptop', '--days', '30'])).toBe(EXIT.ok);
    expect(h.requests[0]?.body).toEqual({ name: 'laptop', days: 30 });
    expect(h.out.filter((line) => line === NEW_TOKEN)).toHaveLength(1);
    expect(h.out).toContain(t('cli.admin.token.shown_once'));
    expect(h.out).not.toContain(t('cli.token.for_other_user'));
    expect(h.err.join('\n')).not.toContain(NEW_TOKEN);
    expect([...h.out, ...h.err].join('\n')).not.toContain(TOKEN);
  });

  it('lists and revokes own tokens', async () => {
    const h = await harness({
      routes: {
        'GET /v1/me/tokens': { status: 200, body: { items: [tokenBody()] } },
        [`DELETE /v1/me/tokens/${TOKEN_ID}`]: {
          status: 200,
          body: tokenBody({ revoked_at: new Date() }),
        },
      },
    });
    expect(await h.run(['token', 'list'])).toBe(EXIT.ok);
    expect(h.out[0]).toContain(TOKEN_ID);
    expect(await h.run(['token', 'revoke', '--id', TOKEN_ID])).toBe(EXIT.ok);
    expect(h.out[1]).toBe(t('cli.admin.token.revoked', { id: TOKEN_ID }));
  });

  it.each([
    [['token']],
    [['token', 'create']],
    [['token', 'create', '--name', 'x', '--days', 'ten']],
    [['token', 'create', '--name', 'x', '--token', 'y']],
    [['token', 'revoke']],
  ])('prints the usage for %j (exit 2, no request)', async (argv) => {
    const h = await harness();
    expect(await h.run(argv)).toBe(EXIT.usage);
    expect(h.err).toEqual([t('cli.token.usage')]);
    expect(h.requests).toEqual([]);
  });
});

describe('sdlc admin token (another user, QUESTIONS #152)', () => {
  it('issues a token for another user and says it must be replaced', async () => {
    const h = await harness({
      routes: {
        [`POST /v1/admin/users/${OTHER_USER}/tokens`]: {
          status: 201,
          body: issuedTokenBody(NEW_TOKEN, true, { user_id: OTHER_USER }),
        },
      },
    });
    expect(
      await h.run([
        'admin',
        'token',
        'issue',
        '--user',
        OTHER_USER,
        '--name',
        'first',
        '--days',
        '7',
      ]),
    ).toBe(EXIT.ok);
    expect(h.requests[0]?.body).toEqual({ name: 'first', days: 7 });
    expect(h.out.filter((line) => line === NEW_TOKEN)).toHaveLength(1);
    expect(h.out.at(-1)).toBe(t('cli.token.for_other_user'));
  });

  it('lists and revokes another user’s tokens', async () => {
    const h = await harness({
      routes: {
        [`GET /v1/admin/users/${OTHER_USER}/tokens`]: { status: 200, body: { items: [] } },
        [`DELETE /v1/admin/users/${OTHER_USER}/tokens/${TOKEN_ID}`]: {
          status: 200,
          body: tokenBody({ user_id: OTHER_USER, revoked_at: new Date() }),
        },
      },
    });
    expect(await h.run(['admin', 'token', 'list', '--user', OTHER_USER])).toBe(EXIT.ok);
    expect(h.out).toEqual([t('cli.admin.token.none')]);
    expect(
      await h.run(['admin', 'token', 'revoke', '--user', OTHER_USER, '--id', TOKEN_ID, '--json']),
    ).toBe(EXIT.ok);
    expect(JSON.parse(h.out[1] ?? '{}')).toMatchObject({ id: TOKEN_ID });
  });

  it('refuses a lifetime that is not a number before calling the API', async () => {
    const h = await harness();
    expect(
      await h.run(['admin', 'token', 'issue', '--user', OTHER_USER, '--name', 'x', '--days', 'x']),
    ).toBe(EXIT.usage);
    expect(h.requests).toEqual([]);
  });
});

describe('sdlc audit verify (tenant admins)', () => {
  it('reports an intact chain (exit 0) and a broken one (exit 1)', async () => {
    const intact = await harness({
      routes: { 'GET /v1/admin/audit/verify': { status: 200, body: chainBody() } },
    });
    expect(await intact.run(['audit', 'verify'])).toBe(EXIT.ok);
    expect(intact.out[0]).toContain('41');
    const broken = await harness({
      routes: { 'GET /v1/admin/audit/verify': { status: 200, body: chainBody(true) } },
    });
    expect(await broken.run(['audit', 'verify', '--json'])).toBe(EXIT.failed);
    expect(JSON.parse(broken.out.join('\n'))).toMatchObject({
      ok: false,
      broken: { seq: 42, reason: 'hash_mismatch' },
    });
  });
});
