// D-08 X04 AC1 on a live PostgreSQL, through the Nest app and Fastify `inject()`: the tool register
// through the API (design/ADR-M69 §2.2). A tenant admin registers; the owner and Person B, or the
// owner and governance, activate; the owner and governance retire; Person B or governance may
// suspend or quarantine at any time. Approvers are always different people; an approval counts
// only for the tool as it is now; a new image digest is a new version.
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
const DIGEST = `sha256:${'d'.repeat(64)}`;
const DIGEST_2 = `sha256:${'e'.repeat(64)}`;

interface Body {
  readonly [field: string]: unknown;
  readonly status: string;
  readonly version: string;
  readonly completed: boolean;
  readonly missing: readonly (readonly string[])[];
  readonly tool: { readonly status: string };
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

describeDb('X04 AC1: the tool register through the API (ADR-M69 §2.2)', () => {
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
    inject('POST', '/v1/admin/tools', admin, {
      key,
      version: '1.0.0',
      owner_id: owner.id,
      transport: 'http',
      image_ref: 'ghcr.io/example/project-docs',
      image_digest: DIGEST,
      permissions: ['read_documents'],
      allowed_data_classes: ['internal', 'public'],
      backing_services: ['knowledge-db:5432'],
      ...extra,
    });

  const approve = (key: string, who: Person, as: string, purpose = 'activate', reason?: string) =>
    inject('POST', `/v1/admin/tools/${key}/approvals`, who, {
      purpose,
      as,
      ...(reason === undefined ? {} : { reason_code: reason }),
    });

  const status = async (key: string) => (await scope.tools.getByKey(key))?.status;

  async function auditActions(): Promise<{ action: string; payload: Record<string, unknown> }[]> {
    return (
      await sql<{ action: string; payload: Record<string, unknown> }>`
        SELECT action, payload FROM audit_log
        WHERE tenant_id = ${scope.tenantId} AND action LIKE 'tool.%' ORDER BY seq`.execute(t0.owner)
    ).rows;
  }

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

  it('only a tenant admin registers; the tool starts proposed with sorted codes', async () => {
    refused(await register('docs-a', { key: 'X' }), 400, 'invalid_request');
    const asOwner = await inject('POST', '/v1/admin/tools', owner, {
      key: 'docs-a',
      version: '1.0.0',
      owner_id: owner.id,
      transport: 'http',
      image_ref: 'ghcr.io/example/project-docs',
      permissions: ['read_documents'],
      allowed_data_classes: ['internal'],
    });
    refused(asOwner, 403, 'forbidden', 'not_permitted');
    const tool = ok(
      await register('docs-a', { allowed_data_classes: ['public', 'internal'] }),
      201,
    );
    expect(tool).toMatchObject({
      key: 'docs-a',
      code: 'tool:docs-a',
      status: 'proposed',
      transport: 'http',
      image_digest: DIGEST,
      permissions: ['read_documents'],
      allowed_data_classes: ['internal', 'public'],
      backing_services: ['knowledge-db:5432'],
      overdue: false,
    });
    refused(await register('docs-a'), 409, 'tool_refused', 'tool_exists');
  });

  it('refuses prohibited data, an unknown permission, a stdio tool with an image, a bad digest', async () => {
    refused(
      await register('docs-b', { allowed_data_classes: ['prohibited'] }),
      400,
      'invalid_request',
    );
    refused(await register('docs-b', { permissions: ['write_documents'] }), 400, 'invalid_request');
    refused(await register('docs-b', { transport: 'stdio' }), 400, 'invalid_request');
    refused(await register('docs-b', { image_digest: 'latest' }), 400, 'invalid_request');
    refused(await register('docs-b', { image_ref: null }), 400, 'invalid_request');
    refused(
      await register('docs-b', { backing_services: ['example.com'] }),
      400,
      'invalid_request',
    );
    expect(await scope.tools.getByKey('docs-b')).toBeUndefined();
  });

  it('activation: the owner and Person B, each a different person; Person A never approves', async () => {
    ok(await register('docs-c'), 201);
    refused(await approve('docs-c', pa, 'person_a'), 403, 'forbidden', 'not_an_approver');
    refused(await approve('docs-c', outsider, 'person_b'), 403, 'forbidden', 'not_an_approver');
    const first = ok(await approve('docs-c', owner, 'owner'));
    expect(first.completed).toBe(false);
    expect(first.missing).toEqual([['person_b'], ['governance']]);
    refused(await approve('docs-c', owner, 'person_a'), 403, 'forbidden', 'not_an_approver');
    const done = ok(await approve('docs-c', pb, 'person_b'));
    expect(done.completed).toBe(true);
    expect(done.tool.status).toBe('active');
    const shown = ok(await inject('GET', '/v1/admin/tools/docs-c', outsider));
    expect(shown.status).toBe('active');
    expect(typeof shown.last_recertified_at).toBe('string');
  });

  it('activation: the owner and governance also complete the set', async () => {
    ok(await register('docs-d'), 201);
    ok(await approve('docs-d', gov, 'governance'));
    const done = ok(await approve('docs-d', owner, 'owner'));
    expect(done).toMatchObject({ completed: true });
    expect(await status('docs-d')).toBe('active');
  });

  it('an http tool without an image digest cannot be activated', async () => {
    ok(await register('docs-e', { image_digest: null }), 201);
    refused(await approve('docs-e', owner, 'owner'), 409, 'tool_refused', 'image_not_pinned');
  });

  it('a change needs suspension and a new version; it starts a new round of approvals', async () => {
    ok(await register('docs-f'), 201);
    ok(await approve('docs-f', owner, 'owner'));
    ok(await approve('docs-f', pb, 'person_b'));
    refused(
      await inject('PATCH', '/v1/admin/tools/docs-f', owner, {
        version: '1.1.0',
        image_digest: DIGEST_2,
      }),
      409,
      'tool_refused',
      'config_change_not_allowed',
    );
    refused(
      await inject('POST', '/v1/admin/tools/docs-f/suspend', owner, { reason_code: 'quality' }),
      403,
      'forbidden',
      'not_permitted',
    );
    ok(await inject('POST', '/v1/admin/tools/docs-f/suspend', pb, { reason_code: 'quality' }));
    refused(
      await inject('PATCH', '/v1/admin/tools/docs-f', owner, {
        version: '1.0.0',
        image_digest: DIGEST_2,
      }),
      409,
      'tool_refused',
      'version_unchanged',
    );
    const changed = ok(
      await inject('PATCH', '/v1/admin/tools/docs-f', owner, {
        version: '1.1.0',
        image_digest: DIGEST_2,
      }),
    );
    expect(changed).toMatchObject({
      version: '1.1.0',
      image_digest: DIGEST_2,
      status: 'suspended',
    });
    // The approvals of version 1.0.0 do not count: a new round.
    const round = ok(await approve('docs-f', owner, 'owner'));
    expect(round.completed).toBe(false);
    ok(await approve('docs-f', gov, 'governance'));
    expect(await status('docs-f')).toBe('active');
  });

  it('retirement: the owner and governance with a reason; the key is never reused', async () => {
    ok(await register('docs-g'), 201);
    refused(
      await approve('docs-g', owner, 'owner', 'retire'),
      409,
      'tool_refused',
      'reason_required',
    );
    refused(
      await approve('docs-g', pb, 'person_b', 'retire', 'unused'),
      403,
      'forbidden',
      'not_an_approver',
    );
    ok(await approve('docs-g', owner, 'owner', 'retire', 'unused'));
    const done = ok(await approve('docs-g', gov, 'governance', 'retire', 'unused'));
    expect(done.tool.status).toBe('retired');
    refused(await register('docs-g'), 409, 'tool_refused', 'tool_exists');
    refused(
      await inject('POST', '/v1/admin/tools/docs-g/quarantine', gov, { reason_code: 'security' }),
      409,
      'tool_refused',
      'tool_retired',
    );
  });

  it('owner: a tenant admin hands over; recertify: the owner only', async () => {
    ok(await register('docs-h'), 201);
    refused(
      await inject('PUT', '/v1/admin/tools/docs-h/owner', owner, { owner_id: pb.id }),
      403,
      'forbidden',
    );
    ok(await inject('PUT', '/v1/admin/tools/docs-h/owner', admin, { owner_id: pb.id }));
    refused(await inject('POST', '/v1/admin/tools/docs-h/recertify', owner, {}), 403, 'forbidden');
    const recert = ok(await inject('POST', '/v1/admin/tools/docs-h/recertify', pb, {}));
    expect(recert.last_recertified_at).toEqual(expect.any(String));
  });

  it('another tenant sees no tool; an unknown tool is 404', async () => {
    refused(await inject('GET', '/v1/admin/tools/docs-a', otherTenantAdmin), 404, 'tool_not_found');
    expect(ok(await inject('GET', '/v1/admin/tools', otherTenantAdmin)).items).toEqual([]);
  });

  it('audits with keys, versions, codes and the digest hex only, never the image name', async () => {
    const rows = await auditActions();
    expect(rows.map((r) => r.action)).toEqual(
      expect.arrayContaining([
        'tool.registered',
        'tool.approval_recorded',
        'tool.status_changed',
        'tool.recertified',
        'tool.updated',
        'tool.owner_changed',
      ]),
    );
    const text = JSON.stringify(rows);
    expect(text).not.toContain('ghcr.io');
    expect(text).not.toContain('knowledge-db');
    expect(rows.find((r) => r.action === 'tool.registered')?.payload).toMatchObject({
      tool_key: 'docs-a',
      transport: 'http',
      image_sha256: 'd'.repeat(64),
    });
  });
});
