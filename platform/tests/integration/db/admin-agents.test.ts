// D-08 B13 AC7 on a live PostgreSQL, through the Nest app and Fastify `inject()`: the agent
// register through the API, enforcing handbook Ch.20 (§20.7 approval for use by agent type, §20.11
// change approval and retirement, §20.9 Person B or leadership may suspend or quarantine at any
// time). Approvers are always different people; an approval counts only for the agent as it is now.
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { createApp, type ApiDeps } from '../../../apps/api/src/app.js';
import { bootstrapTenant } from '../../../packages/core/src/admin/bootstrap.js';
import { issueApiToken } from '../../../packages/core/src/admin/tokens.js';
import { parseTenantId } from '../../../packages/core/src/db/tenant-id.js';
import type { TenantScope } from '../../../packages/core/src/db/tenant-scope.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

type App = Awaited<ReturnType<typeof createApp>>;
const asApiDb = (db: TestDatabase): ApiDeps['db'] => db.app as unknown as ApiDeps['db'];
const MODEL = 'claude-haiku-4-5-20251001';
const SHA = 'c'.repeat(64);

interface Body {
  readonly [field: string]: unknown;
  readonly status: string;
  readonly version: string;
  readonly completed: boolean;
  readonly missing: readonly string[];
  readonly agent: { readonly status: string };
  readonly items: readonly Record<string, unknown>[];
  readonly error: {
    readonly code: string;
    readonly reason?: string;
    readonly reason_message?: string;
  };
}

interface Reply {
  readonly statusCode: number;
  json(): Body;
}

interface Person {
  readonly id: string;
  readonly token: string;
}

describeDb('B13 AC7: the agent register through the API (handbook Ch.20)', () => {
  let t0: TestDatabase;
  let app: App;
  let scope: TenantScope;
  let admin: Person;
  let owner: Person; // also Person A on the project
  let pb: Person;
  let gov: Person;
  let pa: Person; // Person A on another project
  let outsider: Person;
  let otherTenantAdmin: Person;
  // A real clock: approvals bind to `updated_at`, written by the app clock on every change.
  let tick = Date.parse('2026-10-03T03:00:00.000Z');

  const inject = async (
    method: 'GET' | 'POST' | 'PATCH' | 'PUT',
    url: string,
    who: Person,
    body?: unknown,
  ): Promise<Reply> =>
    await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method,
        url,
        headers: { authorization: `Bearer ${who.token}` },
        ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
      });

  const ok = (reply: Reply, status = 200): Body => {
    expect(reply.statusCode, JSON.stringify(reply.json())).toBe(status);
    return reply.json();
  };

  const refused = (reply: Reply, status: number, code: string, reason?: string): Body['error'] => {
    expect(reply.statusCode, JSON.stringify(reply.json())).toBe(status);
    expect(reply.json().error.code).toBe(code);
    if (reason !== undefined) expect(reply.json().error.reason).toBe(reason);
    return reply.json().error;
  };

  async function person(key: string, roles: [string, string][] = []): Promise<Person> {
    const user = await scope.users.create({ display_name: key, email: `${key}@acme.example.com` });
    for (const [projectId, role] of roles) {
      await scope.roleBindings.grant({
        user_id: user.id,
        project_id: projectId,
        role: role as 'person_a',
      });
    }
    const issued = await issueApiToken(scope, { userId: user.id, name: key });
    return { id: user.id, token: issued.token };
  }

  const register = (key: string, extra: Record<string, unknown> = {}) =>
    inject('POST', '/v1/admin/agents', admin, {
      key,
      version: '1.0.0',
      owner_id: owner.id,
      model_ref: MODEL,
      instructions_ref: 'AGENTS.md@v1',
      instructions_sha256: SHA,
      allowed_tools: ['terminal', 'file_editor'],
      max_autonomy: 'L2',
      ...extra,
    });

  const approve = (key: string, who: Person, as: string, purpose = 'activate', reason?: string) =>
    inject('POST', `/v1/admin/agents/${key}/approvals`, who, {
      purpose,
      as,
      ...(reason === undefined ? {} : { reason_code: reason }),
    });

  const status = async (key: string) => (await scope.agents.getByKey(key))?.status;

  beforeAll(async () => {
    t0 = await createTestDatabase();
    const boot = await bootstrapTenant(t0.app, {
      tenantSlug: 'acme',
      tenantName: 'Acme',
      adminEmail: 'admin@acme.example.com',
      adminName: 'Admin',
    });
    scope = t0.app.forTenant(parseTenantId(boot.tenant.id));
    admin = { id: boot.user.id, token: boot.token.token };
    const project = await scope.projects.create({
      slug: 'shop',
      name: 'Shop',
      git_provider: 'github',
      repo_full_name: 'org/shop',
    });
    const second = await scope.projects.create({
      slug: 'docs',
      name: 'Docs',
      git_provider: 'github',
      repo_full_name: 'org/docs',
    });
    owner = await person('owner', [[project.id, 'person_a']]);
    pb = await person('pb', [[project.id, 'person_b']]);
    gov = await person('gov', [[project.id, 'governance']]);
    pa = await person('pa', [[second.id, 'person_a']]);
    outsider = await person('outsider');
    const other = await bootstrapTenant(t0.app, {
      tenantSlug: 'beta',
      tenantName: 'Beta',
      adminEmail: 'admin@beta.example.com',
      adminName: 'Admin',
    });
    otherTenantAdmin = { id: other.user.id, token: other.token.token };
    app = await createApp({
      db: asApiDb(t0),
      settings: { rateLimitPerMinute: 10_000, authFailuresPerMinute: 1000 },
      now: () => new Date((tick += 1000)),
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await t0?.drop();
  });

  it('only a tenant admin registers; the agent starts proposed', async () => {
    const error = refused(
      await inject('POST', '/v1/admin/agents', owner, { key: 'x' }),
      400,
      'invalid_request',
    );
    expect(error.code).toBe('invalid_request');
    const asOwner = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/v1/admin/agents',
        headers: { authorization: `Bearer ${owner.token}` },
        payload: {
          key: 'coder',
          version: '1.0.0',
          owner_id: owner.id,
          instructions_ref: 'AGENTS.md@v1',
          instructions_sha256: SHA,
          max_autonomy: 'L2',
        },
      });
    refused(asOwner, 403, 'forbidden', 'not_permitted');
    expect(ok(await register('coder'), 201)).toMatchObject({ status: 'proposed', key: 'coder' });
  });

  it('§20.7 L1–L2: the technical owner and Person B, two different people', async () => {
    refused(await approve('coder', owner, 'person_b'), 403, 'forbidden', 'not_an_approver');
    refused(await approve('coder', owner, 'person_a'), 403, 'forbidden', 'not_an_approver');
    const first = ok(await approve('coder', owner, 'owner'));
    expect(first).toMatchObject({ completed: false, missing: ['person_b'] });
    const again = refused(await approve('coder', owner, 'owner'), 409, 'agent_refused');
    expect(again.reason).toBe('approval_duplicate');
    expect(again.reason_message).toContain('coder');
    expect(await status('coder')).toBe('proposed');
    const done = ok(await approve('coder', pb, 'person_b'));
    expect(done).toMatchObject({ completed: true, missing: [], agent: { status: 'active' } });
    expect(await status('coder')).toBe('active');
  });

  it('§20.7 L0: Person A (any active project) and the owner; one person never counts twice', async () => {
    ok(await register('reader', { max_autonomy: 'L0' }), 201);
    // The owner also holds Person A on a project, but one person fills one capacity per round.
    ok(await approve('reader', owner, 'person_a'));
    refused(await approve('reader', owner, 'owner'), 409, 'agent_refused', 'approval_duplicate');
    refused(await approve('reader', pb, 'person_b'), 403, 'forbidden', 'not_an_approver');
    expect(await status('reader')).toBe('proposed');
  });

  it('§20.9: Person B or leadership suspend and quarantine at any time; nobody else', async () => {
    refused(
      await inject('POST', '/v1/admin/agents/coder/suspend', owner, { reason_code: 'quality' }),
      403,
      'forbidden',
      'not_permitted',
    );
    refused(
      await inject('POST', '/v1/admin/agents/coder/suspend', admin, { reason_code: 'quality' }),
      403,
      'forbidden',
      'not_permitted',
    );
    const suspended = ok(
      await inject('POST', '/v1/admin/agents/coder/suspend', pb, { reason_code: 'quality' }),
    );
    expect(suspended.status).toBe('suspended');
  });

  it('§20.11: a change needs the owner and Person B again; a change resets the approvals', async () => {
    // Approvals given before a new version do not count for it.
    ok(await approve('coder', owner, 'owner'));
    refused(
      await inject('PATCH', '/v1/admin/agents/coder', outsider, { version: '1.1.0' }),
      403,
      'forbidden',
      'not_permitted',
    );
    const updated = ok(
      await inject('PATCH', '/v1/admin/agents/coder', owner, {
        version: '1.1.0',
        instructions_sha256: 'd'.repeat(64),
      }),
    );
    expect(updated).toMatchObject({ version: '1.1.0', status: 'suspended' });
    const round = ok(await approve('coder', pb, 'person_b'));
    expect(round).toMatchObject({ completed: false, missing: ['owner'] });
    expect(ok(await approve('coder', owner, 'owner')).completed).toBe(true);
    expect(await status('coder')).toBe('active');
  });

  it('a quarantined agent is never activated directly', async () => {
    ok(await inject('POST', '/v1/admin/agents/coder/quarantine', gov, { reason_code: 'security' }));
    refused(
      await approve('coder', owner, 'owner'),
      409,
      'agent_refused',
      'status_move_not_allowed',
    );
    // Back to suspended for review, then a change approval.
    ok(await inject('POST', '/v1/admin/agents/coder/suspend', gov, { reason_code: 'security' }));
    ok(await approve('coder', owner, 'owner'));
    expect(ok(await approve('coder', pb, 'person_b')).completed).toBe(true);
  });

  it('an agent without a pinned model cannot be approved for use', async () => {
    ok(await register('bare', { model_ref: null }), 201);
    refused(await approve('bare', owner, 'owner'), 409, 'agent_refused', 'model_not_pinned');
  });

  it('§20.11 retirement: the owner and leadership, with a reason code', async () => {
    refused(
      await approve('coder', owner, 'owner', 'retire'),
      409,
      'agent_refused',
      'reason_required',
    );
    refused(await approve('coder', pb, 'person_b', 'retire', 'unused'), 403, 'forbidden');
    ok(await approve('coder', owner, 'owner', 'retire', 'unused'));
    expect(ok(await approve('coder', gov, 'governance', 'retire', 'unused')).completed).toBe(true);
    expect(await status('coder')).toBe('retired');
  });

  it('a tenant admin changes the owner; only the owner recertifies', async () => {
    ok(await register('helper'), 201);
    refused(
      await inject('PUT', '/v1/admin/agents/helper/owner', pb, { owner_id: pb.id }),
      403,
      'forbidden',
      'not_permitted',
    );
    ok(await inject('PUT', '/v1/admin/agents/helper/owner', admin, { owner_id: pa.id }));
    refused(
      await inject('POST', '/v1/admin/agents/helper/recertify', owner, {}),
      403,
      'forbidden',
      'not_permitted',
    );
    expect(
      ok(await inject('POST', '/v1/admin/agents/helper/recertify', pa, { day: '2026-10-01' }))
        .last_recertified_at,
    ).toBe('2026-10-01');
  });

  it('anyone of the tenant reads the register with the open rounds; another tenant does not', async () => {
    const listed = ok(await inject('GET', '/v1/admin/agents', outsider)).items;
    expect(listed.map((agent) => agent.key).sort()).toEqual(['bare', 'coder', 'helper', 'reader']);
    const shown = ok(await inject('GET', '/v1/admin/agents/reader', outsider));
    expect(shown.rounds).toMatchObject([
      { purpose: 'activate', required: ['person_a', 'owner'], missing: ['owner'] },
      { purpose: 'retire', required: ['owner', 'governance'], missing: ['owner', 'governance'] },
    ]);
    refused(
      await inject('GET', '/v1/admin/agents/reader', otherTenantAdmin),
      404,
      'agent_not_found',
    );
    expect(ok(await inject('GET', '/v1/admin/agents', otherTenantAdmin)).items).toEqual([]);
  });

  it('every step is audited with the person who did it, codes only; the chain verifies', async () => {
    const rows = (
      await sql<{ action: string; actor_type: string; actor_id: string | null; payload: unknown }>`
        SELECT action, actor_type, actor_id, payload FROM audit_log
        WHERE tenant_id = ${scope.tenantId} AND action LIKE 'agent.%' ORDER BY seq`.execute(
        t0.owner,
      )
    ).rows;
    expect(rows.every((row) => row.actor_type === 'human' && row.actor_id !== null)).toBe(true);
    const approvals = rows.filter((row) => row.action === 'agent.approval_recorded');
    expect(approvals.length).toBeGreaterThanOrEqual(10);
    const activated = rows.find(
      (row) =>
        row.action === 'agent.status_changed' && (row.payload as { to?: string }).to === 'active',
    );
    expect(activated?.actor_id).toBe(pb.id);
    expect(JSON.stringify(rows)).not.toMatch(/claude|@/);
    expect((await scope.audit.verify()).broken).toBeUndefined();
    await expect(
      sql`UPDATE agent_approvals SET capacity = 'owner'`.execute(t0.appRaw),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
