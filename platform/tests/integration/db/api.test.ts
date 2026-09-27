// D-08 B03 on a live PostgreSQL, through the Nest app and Fastify `inject()` (no port):
// AC1 personal API tokens (hash only, expiry, revocation, rate limits), AC2 the tenant comes from
// the token and no other tenant is reachable, AC3 intents and gate decisions through the registry
// and the policy engine (FR-11 roles, FR-17 binding, reason codes), AC4 catalog messages.
import { createHash } from 'node:crypto';

import { loadProjectConfig } from '@sdlc/config';
import { t, type MessageKey } from '@sdlc/messages';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp, type ApiDeps } from '../../../apps/api/src/app.js';
import { issueApiToken, revokeApiToken } from '../../../packages/core/src/admin/tokens.js';
import { intentInputSha256 } from '../../../packages/core/src/commands/gate-input.js';
import type { Intent } from '../../../packages/core/src/db/schema.js';
import { parseTenantId } from '../../../packages/core/src/db/tenant-id.js';
import type { TenantScope } from '../../../packages/core/src/db/tenant-scope.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

type App = Awaited<ReturnType<typeof createApp>>;

/** The test database is the core source class; the app is typed against its built declarations. */
const asApiDb = (db: TestDatabase): ApiDeps['db'] => db.app as unknown as ApiDeps['db'];

const NOW = new Date('2026-09-27T03:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const HASH = (c: string) => c.repeat(64);
const COMMIT = 'c'.repeat(40);

type Role = 'person_a' | 'person_b' | 'second_approver' | 'viewer';

interface Tenant {
  readonly slug: string;
  readonly scope: TenantScope;
  readonly projectId: string;
  readonly users: Record<'a' | 'b' | 'viewer' | 'outsider', string>;
  readonly tokens: Record<'a' | 'b' | 'viewer' | 'outsider', string>;
}

/** The fields the tests read from response bodies. */
interface Body {
  readonly [field: string]: unknown;
  readonly id: string;
  readonly code: string;
  readonly tenant_id: string;
  readonly expires_at: string;
  readonly next_cursor: string | null;
  readonly items: readonly { readonly id: string }[];
  readonly decisions: readonly unknown[];
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly reason?: string;
    readonly reason_message?: string;
    readonly details?: readonly unknown[];
  };
}

interface Reply {
  readonly statusCode: number;
  json(): Body;
}

describeDb('B03: API app on PostgreSQL', () => {
  let t0: TestDatabase;
  let app: App;
  const logged: string[] = [];
  let tenantA: Tenant;
  let tenantB: Tenant;
  let count = 0;

  async function seedTenant(): Promise<Tenant> {
    const slug = `tenant-${String(++count)}`;
    const tenant = await t0.app.system.createTenant({ slug, name: slug });
    const scope = t0.app.forTenant(parseTenantId(tenant.id));
    const project = await scope.projects.create({
      slug: 'shop',
      name: 'Shop',
      git_provider: 'github',
      repo_full_name: 'org/shop',
    });
    const users = {} as Record<'a' | 'b' | 'viewer' | 'outsider', string>;
    const tokens = {} as Record<'a' | 'b' | 'viewer' | 'outsider', string>;
    const roles: Record<keyof typeof users, Role | null> = {
      a: 'person_a',
      b: 'person_b',
      viewer: 'viewer',
      outsider: null,
    };
    for (const [key, role] of Object.entries(roles) as [keyof typeof users, Role | null][]) {
      const user = await scope.users.create({
        display_name: key,
        email: `${key}@${slug}.example.com`,
      });
      users[key] = user.id;
      if (role) await scope.roleBindings.grant({ user_id: user.id, project_id: project.id, role });
      tokens[key] = (await issueApiToken(scope, { userId: user.id, name: key, now: NOW })).token;
    }
    await scope.roleBindings.grant({
      user_id: users.b,
      project_id: project.id,
      role: 'second_approver',
    });
    return { slug, scope, projectId: project.id, users, tokens };
  }

  const inject = async (
    method: 'GET' | 'POST',
    url: string,
    token?: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Reply> =>
    await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method,
        url,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
        ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
      });

  const expectError = (reply: Reply, status: number, code: string, reason?: string) => {
    expect(reply.statusCode, JSON.stringify(reply.json())).toBe(status);
    const error = reply.json().error as Record<string, unknown>;
    expect(error.code).toBe(code);
    expect(error.message).toBe(t(`api.error.${code}` as MessageKey));
    if (reason !== undefined) expect(error.reason).toBe(reason);
  };

  const createIntent = async (tenant: Tenant, extra: Record<string, unknown> = {}) => {
    const reply = await inject('POST', '/v1/intents', tenant.tokens.a, {
      project: 'shop',
      title: 'Add Japanese labels',
      risk_tier: 'low',
      data_class: 'internal',
      ...extra,
    });
    expect(reply.statusCode, JSON.stringify(reply.json())).toBe(201);
    return reply.json();
  };

  const auditCount = async (tenant: Tenant) =>
    Number(
      (
        await sql<{
          n: string;
        }>`SELECT count(*) AS n FROM audit_log WHERE tenant_id = ${tenant.scope.tenantId}`.execute(
          t0.owner,
        )
      ).rows[0]!.n,
    );

  beforeAll(async () => {
    t0 = await createTestDatabase();
    tenantA = await seedTenant();
    tenantB = await seedTenant();
    app = await createApp({
      db: asApiDb(t0),
      settings: { rateLimitPerMinute: 1000, authFailuresPerMinute: 1000 },
      now: () => NOW,
      logger: { error: (...args: unknown[]) => logged.push(args.map(String).join(' ')) },
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await t0?.drop();
  });

  describe('AC1: personal API tokens', () => {
    it('stores only the SHA-256 hash of a token', async () => {
      const rows = await sql<Record<string, unknown>>`SELECT * FROM api_tokens`.execute(t0.owner);
      const dump = JSON.stringify(rows.rows);
      for (const token of Object.values(tenantA.tokens)) {
        expect(token).toMatch(/^sdlc_pat_[A-Za-z0-9_-]{43}$/);
        expect(dump).not.toContain(token);
        expect(dump).toContain(createHash('sha256').update(token).digest('hex'));
      }
    });

    it.each([
      ['no header', undefined, {}],
      ['not a bearer header', undefined, { authorization: 'Basic abc' }],
      ['wrong format', 'not-a-token', {}],
      ['unknown token', `sdlc_pat_${'A'.repeat(43)}`, {}],
    ])('refuses %s with 401', async (_name, token, headers) => {
      expectError(await inject('GET', '/v1/me', token, undefined, headers), 401, 'unauthorized');
    });

    it('refuses a token after its expiry (default 90 days)', async () => {
      const later = (days: number) =>
        createApp({
          db: asApiDb(t0),
          settings: { rateLimitPerMinute: 1000, authFailuresPerMinute: 1000 },
          now: () => new Date(NOW.getTime() + days * DAY_MS),
        });
      for (const [days, status] of [
        [89, 200],
        [91, 401],
      ] as const) {
        const other = await later(days);
        try {
          const reply = await other
            .getHttpAdapter()
            .getInstance()
            .inject({
              method: 'GET',
              url: '/v1/me',
              headers: { authorization: `Bearer ${tenantA.tokens.viewer}` },
            });
          expect(reply.statusCode).toBe(status);
        } finally {
          await other.close();
        }
      }
    });

    it('refuses a revoked token; revoking twice audits once', async () => {
      const issued = await issueApiToken(tenantA.scope, {
        userId: tenantA.users.a,
        name: 'laptop',
        now: NOW,
      });
      expect((await inject('GET', '/v1/me', issued.token)).statusCode).toBe(200);
      const before = await auditCount(tenantA);
      const first = await revokeApiToken(tenantA.scope, issued.record.id, NOW);
      const second = await revokeApiToken(tenantA.scope, issued.record.id, new Date());
      expect(second?.revoked_at).toEqual(first?.revoked_at);
      expect(await auditCount(tenantA)).toBe(before + 1);
      expectError(await inject('GET', '/v1/me', issued.token), 401, 'unauthorized');
    });

    it('refuses tokens of a disabled user and of a suspended tenant', async () => {
      const tenant = await seedTenant();
      await tenant.scope.users.setStatus(tenant.users.viewer, 'disabled');
      expectError(await inject('GET', '/v1/me', tenant.tokens.viewer), 401, 'unauthorized');
      expect((await inject('GET', '/v1/me', tenant.tokens.a)).statusCode).toBe(200);
      await sql`UPDATE tenants SET status = 'suspended' WHERE id = ${tenant.scope.tenantId}`.execute(
        t0.owner,
      );
      expectError(await inject('GET', '/v1/me', tenant.tokens.a), 401, 'unauthorized');
    });

    it('refuses a lifetime above the maximum and a name that is not a code', async () => {
      await expect(
        issueApiToken(tenantA.scope, { userId: tenantA.users.a, name: 'x', lifetimeDays: 366 }),
      ).rejects.toMatchObject({ code: 'invalid_value' });
      await expect(
        issueApiToken(tenantA.scope, { userId: tenantA.users.a, name: 'my laptop' }),
      ).rejects.toMatchObject({ code: 'invalid_value' });
    });

    it('records last use', async () => {
      await inject('GET', '/v1/me', tenantA.tokens.b);
      const rows = await tenantA.scope.apiTokens.listForUser(tenantA.users.b);
      expect(rows[0]?.last_used_at).toEqual(NOW);
    });

    it('limits failed logins per client and requests per token', async () => {
      const limited = await createApp({
        db: asApiDb(t0),
        settings: { rateLimitPerMinute: 2, authFailuresPerMinute: 2 },
        now: () => NOW,
      });
      const call = async (token: string) =>
        (await limited
          .getHttpAdapter()
          .getInstance()
          .inject({
            method: 'GET',
            url: '/v1/me',
            headers: { authorization: `Bearer ${token}` },
          })) as unknown as Reply;
      try {
        expect((await call(tenantA.tokens.a)).statusCode).toBe(200);
        expect((await call(tenantA.tokens.a)).statusCode).toBe(200);
        expect((await call(tenantA.tokens.a)).statusCode).toBe(429);
        const bad = `sdlc_pat_${'B'.repeat(43)}`;
        expect((await call(bad)).statusCode).toBe(401);
        expect((await call(bad)).statusCode).toBe(401);
        const blocked = await call(tenantA.tokens.b);
        expect(blocked.statusCode).toBe(429);
        expect(blocked.json().error.message).toBe(t('api.error.rate_limited'));
      } finally {
        await limited.close();
      }
    });
  });

  describe('AC2: the tenant comes from the token', () => {
    let intentB: { id: string; code: string };

    beforeAll(async () => {
      intentB = await createIntent(tenantB);
    });

    it('/v1/me shows the token tenant only', async () => {
      const me = (await inject('GET', '/v1/me', tenantA.tokens.a)).json();
      expect(me.tenant_id).toBe(tenantA.scope.tenantId);
      expect(me.roles).toEqual([
        { project: { id: tenantA.projectId, slug: 'shop' }, role: 'person_a' },
      ]);
    });

    it('never shows or changes an intent of another tenant', async () => {
      // Tenant A has no intent with this code yet: the code of B is unknown in A.
      for (const ref of [intentB.id]) {
        expectError(
          await inject('GET', `/v1/intents/${ref}`, tenantA.tokens.a),
          404,
          'intent_not_found',
        );
      }
      const before = await auditCount(tenantB);
      expectError(
        await inject('POST', `/v1/intents/${intentB.id}/gates/G1/decisions`, tenantA.tokens.a, {
          decision: 'approve',
        }),
        404,
        'intent_not_found',
      );
      expect(await auditCount(tenantB)).toBe(before);
      const list = (await inject('GET', '/v1/intents', tenantA.tokens.a)).json();
      expect(list.items.map((i: { id: string }) => i.id)).not.toContain(intentB.id);
    });

    it('ignores a tenant header and refuses a tenant field in the body', async () => {
      const me = (
        await inject('GET', '/v1/me', tenantA.tokens.a, undefined, {
          'x-tenant-id': tenantB.scope.tenantId,
        })
      ).json();
      expect(me.tenant_id).toBe(tenantA.scope.tenantId);
      expectError(
        await inject('POST', '/v1/intents', tenantA.tokens.a, {
          project: 'shop',
          title: 'x',
          risk_tier: 'low',
          data_class: 'internal',
          tenant_id: tenantB.scope.tenantId,
        }),
        400,
        'invalid_request',
      );
    });

    it('same intent code in two tenants resolves to each caller’s own intent', async () => {
      const a = await createIntent(tenantA);
      const b = await createIntent(tenantB);
      const shownA = (await inject('GET', `/v1/intents/${a.code}`, tenantA.tokens.a)).json();
      const shownB = (await inject('GET', `/v1/intents/${b.code}`, tenantB.tokens.a)).json();
      expect(shownA.id).toBe(a.id);
      expect(shownB.id).toBe(b.id);
    });
  });

  describe('AC3: intents', () => {
    it('person_a creates a draft intent; max_autonomy from policy; audited', async () => {
      const before = await auditCount(tenantA);
      const created = await createIntent(tenantA, { risk_tier: 'high', description: 'd' });
      expect(created.code).toMatch(/^INT-2026-\d{4}$/);
      expect(created).toMatchObject({
        status: 'draft',
        max_autonomy: 'L1',
        created_by: tenantA.users.a,
        project: { id: tenantA.projectId, slug: 'shop' },
        budget_usd: '10.000000',
      });
      expect(await auditCount(tenantA)).toBe(before + 1);
    });

    it('viewer: 403; no role: 404; unknown project: 404; bad body: 400 with details', async () => {
      const body = { project: 'shop', title: 't', risk_tier: 'low', data_class: 'internal' };
      expectError(
        await inject('POST', '/v1/intents', tenantA.tokens.viewer, body),
        403,
        'forbidden',
      );
      expectError(
        await inject('POST', '/v1/intents', tenantA.tokens.outsider, body),
        404,
        'project_not_found',
      );
      expectError(
        await inject('POST', '/v1/intents', tenantA.tokens.a, { ...body, project: 'nope' }),
        404,
        'project_not_found',
      );
      const bad = await inject('POST', '/v1/intents', tenantA.tokens.a, {
        ...body,
        risk_tier: 'extreme',
      });
      expectError(bad, 400, 'invalid_request');
      expect(bad.json().error.details).toEqual([
        { path: 'body.risk_tier', issue: 'invalid_value' },
      ]);
    });

    it('lists readable intents with pages, filters and hides them from outsiders', async () => {
      const tenant = await seedTenant();
      const made = [];
      for (let i = 0; i < 3; i++) made.push(await createIntent(tenant));
      const first = (await inject('GET', '/v1/intents?limit=2', tenant.tokens.viewer)).json();
      expect(first.items).toHaveLength(2);
      const second = (
        await inject('GET', `/v1/intents?limit=2&cursor=${first.next_cursor}`, tenant.tokens.viewer)
      ).json();
      expect(second.items).toHaveLength(1);
      expect(second.next_cursor).toBeNull();
      const ids = [...first.items, ...second.items].map((i: { id: string }) => i.id).sort();
      expect(ids).toEqual(made.map((m) => m.id).sort());
      expect(
        (await inject('GET', '/v1/intents?status=done', tenant.tokens.a)).json().items,
      ).toEqual([]);
      expect((await inject('GET', '/v1/intents', tenant.tokens.outsider)).json().items).toEqual([]);
      expectError(
        await inject('GET', '/v1/intents?project=shop', tenant.tokens.outsider),
        404,
        'project_not_found',
      );
      expectError(
        await inject('GET', `/v1/intents/${made[0]!.code}`, tenant.tokens.outsider),
        404,
        'intent_not_found',
      );
      expectError(
        await inject('GET', '/v1/intents?cursor=bad', tenant.tokens.a),
        400,
        'invalid_request',
      );
    });
  });

  describe('AC3: gate decisions (FR-11, FR-17, ADR-M20)', () => {
    const decide = (
      tenant: Tenant,
      who: keyof Tenant['tokens'],
      code: string,
      gate: string,
      body: unknown,
    ) => inject('POST', `/v1/intents/${code}/gates/${gate}/decisions`, tenant.tokens[who], body);

    it('G1: person_a approves, bound to the intent and an expiry', async () => {
      const created = await createIntent(tenantA);
      const reply = await decide(tenantA, 'a', created.code, 'G1', { decision: 'approve' });
      expect(reply.statusCode, JSON.stringify(reply.json())).toBe(201);
      const intent = (await tenantA.scope.intents.getById(created.id)) as Intent;
      expect(reply.json()).toMatchObject({
        gate: 'G1',
        decision: 'approve',
        oversight_mode: 'HITL',
        approver_role: 'person_a',
        decided_by: tenantA.users.a,
        input_sha256: intentInputSha256(intent),
        source: 'cli',
      });
      expect(new Date(reply.json().expires_at).getTime()).toBeGreaterThan(NOW.getTime());
      const shown = (await inject('GET', `/v1/intents/${created.code}`, tenantA.tokens.b)).json();
      expect(shown.decisions).toHaveLength(1);
    });

    it('G1: a person without the gate role is refused (FR-11)', async () => {
      const created = await createIntent(tenantA);
      expectError(
        await decide(tenantA, 'b', created.code, 'G1', { decision: 'approve' }),
        403,
        'approval_refused',
        'role_missing',
      );
      expectError(
        await decide(tenantA, 'viewer', created.code, 'G1', {
          decision: 'reject',
          reason_code: 'spec_unclear',
        }),
        403,
        'decision_not_allowed',
        'role_missing',
      );
      const reply = await decide(tenantA, 'outsider', created.code, 'G1', { decision: 'approve' });
      expectError(reply, 404, 'intent_not_found');
    });

    it('reject needs a reason code; reason_ref must be https; no free text', async () => {
      const created = await createIntent(tenantA);
      const missing = await decide(tenantA, 'a', created.code, 'G1', { decision: 'reject' });
      expectError(missing, 422, 'decision_not_allowed', 'reason_required');
      expect(missing.json().error.reason_message).toBe(t('api.reason.reason_required'));
      expectError(
        await decide(tenantA, 'a', created.code, 'G1', {
          decision: 'reject',
          reason_code: 'spec_unclear',
          reason_ref: 'http://example.com/c/1',
        }),
        400,
        'invalid_request',
      );
      expectError(
        await decide(tenantA, 'a', created.code, 'G1', {
          decision: 'reject',
          reason_code: 'spec_unclear',
          reason: 'the spec is unclear',
        }),
        400,
        'invalid_request',
      );
      const ok = await decide(tenantA, 'a', created.code, 'G1', {
        decision: 'reject',
        reason_code: 'spec_unclear',
        reason_ref: 'https://github.com/org/shop/issues/1#issuecomment-2',
      });
      expect(ok.statusCode).toBe(201);
      expect(ok.json()).toMatchObject({ decision: 'reject', reason_code: 'spec_unclear' });
    });

    it('G2 binds to the spec; Low is HOTL, Medium HITL; no spec → 409', async () => {
      for (const [tier, mode] of [
        ['low', 'HOTL'],
        ['medium', 'HITL'],
      ] as const) {
        const created = await createIntent(tenantA, { risk_tier: tier });
        expectError(
          await decide(tenantA, 'a', created.code, 'G2', { decision: 'approve' }),
          409,
          'gate_input_missing',
        );
        await tenantA.scope.specRefs.link(created.id, {
          actorType: 'human',
          actorId: tenantA.users.a,
          path: 'docs/specs/T01.md',
          commitSha: COMMIT,
          contentSha256: HASH('d'),
          sourceTool: 'manual',
        });
        const reply = await decide(tenantA, 'a', created.code, 'G2', { decision: 'approve' });
        expect(reply.statusCode, JSON.stringify(reply.json())).toBe(201);
        expect(reply.json()).toMatchObject({ oversight_mode: mode, input_sha256: HASH('d') });
      }
    });

    it('G3 binds to the plan; a Low plan flagged migration is HITL (FR-15)', async () => {
      const created = await createIntent(tenantA);
      expectError(
        await decide(tenantA, 'b', created.code, 'G3', { decision: 'approve' }),
        409,
        'gate_input_missing',
      );
      await tenantA.scope.plans.submit(created.id, {
        actorType: 'human',
        actorId: tenantA.users.a,
        plannedFiles: ['apps/api/**'],
        planSha256: HASH('e'),
        changeFlags: ['migration'],
      });
      const reply = await decide(tenantA, 'b', created.code, 'G3', {
        decision: 'approve',
        scope: { environment: 'staging' },
      });
      expect(reply.statusCode, JSON.stringify(reply.json())).toBe(201);
      expect(reply.json()).toMatchObject({
        oversight_mode: 'HITL',
        approver_role: 'person_b',
        input_sha256: HASH('e'),
        scope: { environment: 'staging' },
      });
    });

    it('G4–G8 are not supported yet; unknown gates are invalid', async () => {
      const created = await createIntent(tenantA);
      expectError(
        await decide(tenantA, 'b', created.code, 'G7', { decision: 'approve' }),
        422,
        'gate_not_supported',
      );
      expectError(
        await decide(tenantA, 'b', created.code, 'G9', { decision: 'approve' }),
        400,
        'invalid_request',
      );
      expectError(
        await decide(tenantA, 'b', created.code, 'G1', { decision: 'pass' }),
        400,
        'invalid_request',
      );
    });
  });

  describe('health, unknown routes and logging', () => {
    it('health needs no token', async () => {
      expect((await inject('GET', '/health/live')).json()).toEqual({ status: 'ok' });
      expect((await inject('GET', '/health/ready')).json()).toEqual({ status: 'ok' });
    });

    it('unknown routes get the envelope', async () => {
      expectError(await inject('GET', '/v1/nothing', tenantA.tokens.a), 404, 'not_found');
    });

    it('never logs a token', () => {
      const all = logged.join('\n');
      for (const token of [...Object.values(tenantA.tokens), ...Object.values(tenantB.tokens)]) {
        expect(all).not.toContain(token);
      }
    });
  });

  describe('M16 through the API: a stored config cannot let viewers create', () => {
    it('refuses such a configuration at load time', () => {
      const loaded = loadProjectConfig('access:\n  intent_create_roles: [viewer]\n');
      expect(loaded.ok).toBe(false);
    });
  });
});
