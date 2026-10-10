// D-08 B13 AC5 on a live PostgreSQL, through the Nest app and Fastify `inject()` (no port):
// personal API tokens through the API (own tokens; a tenant admin's first token for another user,
// at most 7 days, audited with the issuer, QUESTIONS #152), `DELETE /v1/me/tokens/current` for
// `sdlc logout`, and `sdlc audit verify` through the API for tenant admins. No token in the logs.
import { createHash } from 'node:crypto';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp, type ApiDeps } from '../../../apps/api/src/app.js';
import { bootstrapTenant } from '../../../packages/core/src/admin/bootstrap.js';
import { issueApiToken } from '../../../packages/core/src/admin/tokens.js';
import { parseTenantId } from '../../../packages/core/src/db/tenant-id.js';
import type { TenantScope } from '../../../packages/core/src/db/tenant-scope.js';
import { createJsonLogger } from '../../../packages/core/src/observability/index.js';
import { createTestDatabase, describeDb, tamper, type TestDatabase } from './helpers.js';

type App = Awaited<ReturnType<typeof createApp>>;
const asApiDb = (db: TestDatabase): ApiDeps['db'] => db.app as unknown as ApiDeps['db'];
// The api's clock, near the real one: `api_tokens.created_at` is the database's `now()`, and the
// CHECK `expires_at > created_at` refuses a token whose fixed-clock expiry is already past.
const NOW = new Date(Math.floor(Date.now() / 1000) * 1000);
const DAY_MS = 24 * 60 * 60 * 1000;

interface Body {
  readonly [field: string]: unknown;
  readonly id: string;
  readonly token: string;
  readonly items: readonly Record<string, unknown>[];
  readonly error: { readonly code: string };
}

interface Reply {
  readonly statusCode: number;
  json(): Body;
}

describeDb('B13 AC5: tokens and the audit check through the API', () => {
  let t0: TestDatabase;
  let app: App;
  const lines: string[] = [];
  let scope: TenantScope;
  let admin: { id: string; token: string };
  let user: { id: string; token: string };
  let other: { id: string; token: string };
  const minted: string[] = [];

  const inject = async (
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    token: string,
    body?: unknown,
  ): Promise<Reply> =>
    await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method,
        url,
        headers: { authorization: `Bearer ${token}` },
        ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
      });

  const status = (reply: Reply, expected: number, code?: string): Body => {
    expect(reply.statusCode, JSON.stringify(reply.json())).toBe(expected);
    if (code !== undefined) expect(reply.json().error.code).toBe(code);
    return reply.json();
  };

  async function person(key: string): Promise<{ id: string; token: string }> {
    const created = await scope.users.create({
      display_name: key,
      email: `${key}@acme.example.com`,
    });
    const issued = await issueApiToken(scope, { userId: created.id, name: key, now: NOW });
    return { id: created.id, token: issued.token };
  }

  beforeAll(async () => {
    t0 = await createTestDatabase();
    const boot = await bootstrapTenant(t0.app, {
      tenantSlug: 'acme',
      tenantName: 'Acme',
      adminEmail: 'admin@acme.example.com',
      adminName: 'Admin',
      now: NOW,
    });
    scope = t0.app.forTenant(parseTenantId(boot.tenant.id));
    admin = { id: boot.user.id, token: boot.token.token };
    user = await person('user');
    other = await person('other');
    app = await createApp({
      db: asApiDb(t0),
      settings: { rateLimitPerMinute: 10_000, authFailuresPerMinute: 1000 },
      now: () => NOW,
      logger: { error: (...args: unknown[]) => lines.push(args.map(String).join(' ')) },
      log: createJsonLogger({ write: (line) => lines.push(line) }),
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await t0?.drop();
  });

  describe('own tokens', () => {
    it('creates a token shown once, stores only its hash, and it works', async () => {
      const created = status(
        await inject('POST', '/v1/me/tokens', user.token, { name: 'laptop', days: 30 }),
        201,
      );
      minted.push(created.token);
      expect(created).toMatchObject({
        user_id: user.id,
        name: 'laptop',
        for_other_user: false,
        expires_at: new Date(NOW.getTime() + 30 * DAY_MS).toISOString(),
      });
      expect(created.token).toMatch(/^sdlc_pat_[A-Za-z0-9_-]{43}$/);
      const stored = await sql<{ token_hash: string }>`
        SELECT token_hash FROM api_tokens WHERE id = ${created.id}`.execute(t0.owner);
      expect(stored.rows[0]?.token_hash).toBe(
        createHash('sha256').update(created.token).digest('hex'),
      );
      status(await inject('GET', '/v1/me', created.token), 200);
      const listed = status(await inject('GET', '/v1/me/tokens', user.token), 200).items;
      expect(listed.map((row) => row.name).sort()).toEqual(['laptop', 'user']);
      expect(JSON.stringify(listed)).not.toMatch(/sdlc_pat_|token_hash/);
    });

    it('refuses a bad name or lifetime', async () => {
      for (const body of [
        { name: 'has space' },
        { name: 'x', days: 0 },
        { name: 'x', days: 366 },
      ]) {
        status(await inject('POST', '/v1/me/tokens', user.token, body), 400, 'invalid_request');
      }
    });

    it('revokes an own token; another person’s token is not found', async () => {
      const created = status(
        await inject('POST', '/v1/me/tokens', user.token, { name: 'spare' }),
        201,
      );
      minted.push(created.token);
      status(
        await inject('DELETE', `/v1/me/tokens/${created.id}`, other.token),
        404,
        'token_not_found',
      );
      const revoked = status(
        await inject('DELETE', `/v1/me/tokens/${created.id}`, user.token),
        200,
      );
      expect(revoked.revoked_at).toBe(NOW.toISOString());
      status(await inject('GET', '/v1/me', created.token), 401, 'unauthorized');
    });

    it('revokes the token of the request (sdlc logout)', async () => {
      const created = status(
        await inject('POST', '/v1/me/tokens', user.token, { name: 'session' }),
        201,
      );
      minted.push(created.token);
      const revoked = status(await inject('DELETE', '/v1/me/tokens/current', created.token), 200);
      expect(revoked.id).toBe(created.id);
      status(await inject('GET', '/v1/me', created.token), 401, 'unauthorized');
      status(await inject('GET', '/v1/me', user.token), 200);
    });
  });

  describe('tokens of other users (QUESTIONS #152)', () => {
    it('a tenant admin issues a short-lived first token, audited with the issuer', async () => {
      const issued = status(
        await inject('POST', `/v1/admin/users/${other.id}/tokens`, admin.token, { name: 'first' }),
        201,
      );
      minted.push(issued.token);
      expect(issued).toMatchObject({
        user_id: other.id,
        for_other_user: true,
        expires_at: new Date(NOW.getTime() + 7 * DAY_MS).toISOString(),
      });
      status(
        await inject('POST', `/v1/admin/users/${other.id}/tokens`, admin.token, {
          name: 'long',
          days: 8,
        }),
        400,
        'invalid_request',
      );
      const event = (
        await sql<{ actor_type: string; actor_id: string; payload: unknown }>`
          SELECT actor_type, actor_id, payload FROM audit_log
          WHERE tenant_id = ${scope.tenantId} AND entity_id = ${issued.id}`.execute(t0.owner)
      ).rows;
      expect(event).toEqual([
        { actor_type: 'human', actor_id: admin.id, payload: { user_id: other.id } },
      ]);
    });

    it('a tenant admin lists and revokes another user’s tokens; others may not', async () => {
      const path = `/v1/admin/users/${other.id}/tokens`;
      const listed = status(await inject('GET', path, admin.token), 200).items;
      expect(listed.length).toBeGreaterThanOrEqual(2);
      status(await inject('GET', path, user.token), 403, 'forbidden');
      status(await inject('POST', path, user.token, { name: 'sneaky' }), 403, 'forbidden');
      const target = listed.find((row) => row.name === 'first')!;
      status(await inject('DELETE', `${path}/${String(target.id)}`, user.token), 403, 'forbidden');
      const revoked = status(
        await inject('DELETE', `${path}/${String(target.id)}`, admin.token),
        200,
      );
      expect(revoked.revoked_at).toBe(NOW.toISOString());
    });

    it('a disabled user gets no new token', async () => {
      const late = await person('late');
      await scope.users.setStatus(late.id, 'disabled');
      status(
        await inject('POST', `/v1/admin/users/${late.id}/tokens`, admin.token, { name: 'x' }),
        409,
        'user_not_active',
      );
    });
  });

  describe('audit verify through the API', () => {
    it('a tenant admin checks the chain; a broken record is reported, not an error', async () => {
      const intact = status(await inject('GET', '/v1/admin/audit/verify', admin.token), 200);
      expect(intact).toMatchObject({ tenant_id: scope.tenantId, ok: true, broken: null });
      expect(intact.checked).toBeGreaterThan(5);
      status(await inject('GET', '/v1/admin/audit/verify', user.token), 403, 'forbidden');
      await tamper(
        t0.name,
        `UPDATE audit_log SET payload = '{"user_id":"00000000-0000-4000-8000-000000000000"}'
         WHERE tenant_id = $1 AND seq = 3`,
        [scope.tenantId],
      );
      const broken = status(await inject('GET', '/v1/admin/audit/verify', admin.token), 200);
      expect(broken).toMatchObject({ ok: false, broken: { seq: 3, reason: 'hash_mismatch' } });
    });
  });

  it('no log line holds a token', () => {
    const all = lines.join('\n');
    for (const token of [...minted, admin.token, user.token, other.token]) {
      expect(all).not.toContain(token);
    }
    expect(all).not.toMatch(/sdlc_pat_/);
  });
});
