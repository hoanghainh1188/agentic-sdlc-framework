// D-08 E04 on a live PostgreSQL, through the Nest app and Fastify `inject()` (no port), with real
// `cost_records` and runs. AC1: the report of the whole tenant, one project, one intent, over a
// half-open UTC range. AC2: tokens in and out, cached tokens, cost and wasted tokens and cost
// (runs that ended failed, cancelled or stopped; QUESTIONS #195). Also: exact decimal sums (D-05 D6),
// the grouping, runs in progress, freshness (QUESTIONS #197), who may read it (QUESTIONS #196:
// tenant admin, `access.cost_read_roles`, viewer 403, no role 404), and tenant isolation.
import type { RunStatus } from '@sdlc/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp, type ApiDeps } from '../../../apps/api/src/app.js';
import { issueApiToken } from '../../../packages/core/src/admin/tokens.js';
import type { TenantScope } from '../../../packages/core/src/db/tenant-scope.js';
import { issueRun, seedRun, type SeededRun } from '../cost-seed.js';
import { createTestDatabase, describeDb, tamper, type TestDatabase } from './helpers.js';

type App = Awaited<ReturnType<typeof createApp>>;
const asApiDb = (db: TestDatabase): ApiDeps['db'] => db.app as unknown as ApiDeps['db'];

const NOW = new Date('2026-10-04T09:00:00.000Z');
const SEED_AT = new Date('2026-10-01T01:00:00.000Z');
const MODEL = 'claude-haiku-4-5';

type Who = 'admin' | 'a' | 'pm' | 'second' | 'viewer' | 'outsider';

interface Tenant {
  readonly seeded: SeededRun;
  readonly scope: TenantScope;
  readonly opsProjectId: string;
  readonly tokens: Record<Who, string>;
  /** Run IDs by the status they end in. */
  readonly runs: Partial<Record<RunStatus, string>>;
}

interface Amounts {
  readonly calls: number;
  readonly input_tokens: string;
  readonly output_tokens: string;
  readonly cached_input_tokens: string;
  readonly cost_usd: string;
  readonly wasted_tokens: string;
  readonly wasted_cost_usd: string;
}

interface Report {
  readonly scope: Record<string, string>;
  readonly from: string;
  readonly to: string;
  readonly group_by: string;
  readonly totals: Amounts;
  readonly rows: readonly (Amounts & { readonly key: string | null })[];
  readonly truncated: boolean;
  readonly freshness: {
    readonly latest_call_at: string | null;
    readonly last_recorded_at: string | null;
    readonly runs_in_progress: number;
  };
}

describeDb('E04: cost report on PostgreSQL', () => {
  let t0: TestDatabase;
  let app: App;
  let tenantA: Tenant;
  let tenantB: Tenant;
  let source = 0;

  async function record(
    scope: TenantScope,
    r: {
      projectId: string;
      intentId?: string | null;
      runId?: string | null;
      input: number;
      output: number;
      cached?: number;
      cost: string;
      at?: Date;
    },
  ): Promise<void> {
    await scope.costRecords.insertIfNew({
      projectId: r.projectId,
      intentId: r.intentId ?? null,
      runId: r.runId ?? null,
      gate: null,
      agent: null,
      model: MODEL,
      providerType: 'api',
      inputTokens: r.input,
      outputTokens: r.output,
      cachedInputTokens: r.cached ?? 0,
      costUsd: r.cost,
      sourceRef: `req-${String(++source)}`,
      occurredAt: r.at ?? new Date('2026-10-02T10:00:00.000Z'),
    });
  }

  /** Runs end through the runner and the workflow; here the status is set directly. */
  const endRun = (runId: string, status: RunStatus) =>
    tamper(t0.name, `UPDATE runs SET status = $1, stop_reason = $2 WHERE id = $3`, [
      status,
      status === 'stopped_killed' ? 'killed' : status === 'failed' ? 'agent_error' : null,
      runId,
    ]);

  async function seedTenant(slug: string): Promise<Tenant> {
    const seeded = await seedRun(t0.app, { slug, models: [MODEL], now: SEED_AT });
    const { scope } = seeded;
    const ops = await scope.projects.create({
      slug: 'ops',
      name: 'Ops',
      git_provider: 'github',
      repo_full_name: 'org/ops',
    });
    const roles: Record<Who, string | null> = {
      admin: null,
      a: 'person_a',
      pm: 'pm_brse',
      second: 'second_approver',
      viewer: 'viewer',
      outsider: null,
    };
    const tokens = {} as Record<Who, string>;
    for (const [who, role] of Object.entries(roles) as [Who, string | null][]) {
      const user =
        who === 'a'
          ? seeded.personA
          : (await scope.users.create({ display_name: who, email: `${who}@${slug}.example.com` }))
              .id;
      if (role) {
        await scope.roleBindings.grant({
          user_id: user,
          project_id: seeded.projectId,
          role: role as 'person_a',
        });
      }
      if (who === 'admin') await scope.tenantRoles.grant({ user_id: user, role: 'tenant_admin' });
      tokens[who] = (await issueApiToken(scope, { userId: user, name: who, now: NOW })).token;
    }
    const ids = {
      intentId: seeded.intentId,
      planId: seeded.planId,
      personA: seeded.personA,
      agentId: seeded.agentId,
    };
    const runs: Partial<Record<RunStatus, string>> = { succeeded: seeded.runId };
    for (const status of [
      'failed',
      'stopped_killed',
      'running',
      'succeeded_proposal_only',
    ] as const) {
      runs[status] = await issueRun(scope, ids, { models: [MODEL], now: SEED_AT });
    }
    for (const [status, id] of Object.entries(runs) as [RunStatus, string][]) {
      await endRun(id, status);
    }
    return { seeded, scope, opsProjectId: ops.id, tokens, runs };
  }

  const inject = async (url: string, token: string) =>
    await app
      .getHttpAdapter()
      .getInstance()
      .inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

  const report = async (url: string, token: string): Promise<Report> => {
    const reply = await inject(url, token);
    expect(reply.statusCode, reply.body).toBe(200);
    return reply.json<{ report: Report }>().report;
  };

  const refused = async (url: string, token: string, status: number, code: string) => {
    const reply = await inject(url, token);
    expect(reply.statusCode, reply.body).toBe(status);
    expect(reply.json<{ error: { code: string } }>().error.code).toBe(code);
    return reply.json<{ error: { details?: { path: string; issue: string }[] } }>();
  };

  beforeAll(async () => {
    t0 = await createTestDatabase();
    tenantA = await seedTenant('acme');
    tenantB = await seedTenant('other');
    const a = tenantA;
    const shop = a.seeded.projectId;
    const intentId = a.seeded.intentId;
    const run = (status: RunStatus) => ({ projectId: shop, intentId, runId: a.runs[status]! });
    // 0.1 + 0.2 must be exactly 0.3: money is never a float.
    await record(a.scope, { ...run('succeeded'), input: 100, output: 50, cached: 10, cost: '0.1' });
    await record(a.scope, { ...run('succeeded'), input: 200, output: 20, cost: '0.2' });
    await record(a.scope, { ...run('failed'), input: 1000, output: 500, cost: '0.000001' });
    await record(a.scope, { ...run('stopped_killed'), input: 10, output: 5, cost: '0.123456' });
    await record(a.scope, { ...run('running'), input: 7, output: 3, cost: '0.05' });
    await record(a.scope, {
      ...run('succeeded_proposal_only'),
      input: 1,
      output: 1,
      cost: '0.000002',
    });
    // A record with no run (the schema allows it): in the totals, never wasted.
    await record(a.scope, { projectId: a.opsProjectId, input: 50, output: 50, cost: '1' });
    // Outside the default range (September), and exactly at the end of a range (excluded).
    await record(a.scope, {
      ...run('failed'),
      input: 9,
      output: 9,
      cost: '9',
      at: new Date('2026-09-30T23:59:59.999Z'),
    });
    await record(a.scope, {
      ...run('succeeded'),
      input: 4,
      output: 4,
      cost: '4',
      at: new Date('2026-10-03T00:00:00.000Z'),
    });
    // Another tenant's spend is never counted.
    await record(tenantB.scope, {
      projectId: tenantB.seeded.projectId,
      intentId: tenantB.seeded.intentId,
      runId: tenantB.runs.failed!,
      input: 777,
      output: 777,
      cost: '77.7',
    });
    app = await createApp({
      db: asApiDb(t0),
      settings: { rateLimitPerMinute: 1000, authFailuresPerMinute: 1000 },
      now: () => NOW,
      logger: { error: () => undefined },
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await t0?.drop();
  });

  describe('AC1, AC2: the whole tenant (tenant admin)', () => {
    it('sums the current UTC month by project, with exact decimals and wasted tokens', async () => {
      const r = await report('/v1/cost/report', tenantA.tokens.admin);
      expect(r.scope).toEqual({ kind: 'tenant' });
      expect(r.from).toBe('2026-10-01T00:00:00.000Z');
      expect(r.to).toBe(NOW.toISOString());
      expect(r.group_by).toBe('project');
      expect(r.totals).toEqual({
        calls: 8,
        input_tokens: '1372',
        output_tokens: '633',
        cached_input_tokens: '10',
        cost_usd: '5.473459',
        // failed 1500 + stopped_killed 15; running, succeeded and the proposal are not wasted.
        wasted_tokens: '1515',
        wasted_cost_usd: '0.123457',
      });
      expect(r.rows.map((row) => [row.key, row.cost_usd])).toEqual([
        ['shop', '4.473459'],
        ['ops', '1.000000'],
      ]);
      expect(r.truncated).toBe(false);
    });

    it('reads the freshness: the latest call, the last write, the runs in progress', async () => {
      const r = await report('/v1/cost/report', tenantA.tokens.admin);
      expect(r.freshness.latest_call_at).toBe('2026-10-03T00:00:00.000Z');
      expect(r.freshness.last_recorded_at).not.toBeNull();
      expect(r.freshness.runs_in_progress).toBe(1);
    });

    it('uses a half-open range: from included, to excluded', async () => {
      const r = await report(
        '/v1/cost/report?from=2026-09-30T23:59:59.999Z&to=2026-10-03',
        tenantA.tokens.admin,
      );
      expect(r.totals.calls).toBe(8);
      expect(r.totals.cost_usd).toBe('10.473459');
      const onlySeptember = await report(
        '/v1/cost/report?from=2026-09-01&to=2026-10-01',
        tenantA.tokens.admin,
      );
      expect(onlySeptember.totals).toMatchObject({ calls: 1, wasted_tokens: '18' });
    });

    it('groups by run status: succeeded 0.1 + 0.2 is exactly 0.3; no run is null', async () => {
      const r = await report('/v1/cost/report?to=2026-10-03&by=status', tenantA.tokens.admin);
      expect(r.group_by).toBe('status');
      const byKey = Object.fromEntries(r.rows.map((row) => [String(row.key), row]));
      expect(byKey['succeeded']).toMatchObject({
        calls: 2,
        cost_usd: '0.300000',
        wasted_tokens: '0',
      });
      expect(byKey['failed']).toMatchObject({ wasted_tokens: '1500', wasted_cost_usd: '0.000001' });
      expect(byKey['stopped_killed']).toMatchObject({ wasted_tokens: '15' });
      expect(byKey['running']).toMatchObject({ wasted_tokens: '0', cost_usd: '0.050000' });
      expect(byKey['succeeded_proposal_only']).toMatchObject({ wasted_tokens: '0' });
      expect(byKey['null']).toMatchObject({ cost_usd: '1.000000', wasted_tokens: '0' });
    });

    it('a request with ?by= returns that grouping (model)', async () => {
      const r = await report('/v1/cost/report?by=model', tenantA.tokens.admin);
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]).toMatchObject({ key: MODEL, calls: 8 });
    });

    it('never counts another tenant: each admin sees only their own spend', async () => {
      const b = await report('/v1/cost/report', tenantB.tokens.admin);
      expect(b.totals).toMatchObject({ calls: 1, cost_usd: '77.700000', wasted_tokens: '1554' });
      const a = await report('/v1/cost/report', tenantA.tokens.admin);
      expect(a.totals.cost_usd).not.toContain('77');
    });
  });

  describe('AC1: one project or one intent (access.cost_read_roles)', () => {
    it('a project for Person A, grouped by intent; the default for PM / BrSE too', async () => {
      const r = await report('/v1/cost/report?project=shop&to=2026-10-03', tenantA.tokens.a);
      expect(r.scope).toEqual({ kind: 'project', project: 'shop' });
      expect(r.group_by).toBe('intent');
      expect(r.rows).toEqual([
        expect.objectContaining({ key: tenantA.seeded.intentCode, calls: 6, cost_usd: '0.473459' }),
      ]);
      const pm = await report('/v1/cost/report?project=shop&to=2026-10-03', tenantA.tokens.pm);
      expect(pm.totals).toEqual(r.totals);
    });

    it('an intent, grouped by model', async () => {
      const code = tenantA.seeded.intentCode;
      const r = await report(`/v1/cost/report?intent=${code}&to=2026-10-03`, tenantA.tokens.a);
      expect(r.scope).toEqual({ kind: 'intent', project: 'shop', intent: code });
      expect(r.group_by).toBe('model');
      expect(r.totals).toMatchObject({ calls: 6, wasted_tokens: '1515' });
    });

    it('a tenant admin reads any project, also one where they hold no role', async () => {
      const r = await report('/v1/cost/report?project=ops', tenantA.tokens.admin);
      expect(r.totals.cost_usd).toBe('1.000000');
    });

    it('refuses: the whole tenant without a tenant admin (403)', async () => {
      await refused('/v1/cost/report', tenantA.tokens.a, 403, 'forbidden');
    });

    it('refuses: viewer and a role outside cost_read_roles (403), no role (404)', async () => {
      const code = tenantA.seeded.intentCode;
      await refused('/v1/cost/report?project=shop', tenantA.tokens.viewer, 403, 'forbidden');
      await refused('/v1/cost/report?project=shop', tenantA.tokens.second, 403, 'forbidden');
      await refused(`/v1/cost/report?intent=${code}`, tenantA.tokens.viewer, 403, 'forbidden');
      await refused(
        '/v1/cost/report?project=shop',
        tenantA.tokens.outsider,
        404,
        'project_not_found',
      );
      await refused('/v1/cost/report?project=ops', tenantA.tokens.a, 404, 'project_not_found');
      await refused(
        `/v1/cost/report?intent=${code}`,
        tenantA.tokens.outsider,
        404,
        'intent_not_found',
      );
      await refused('/v1/cost/report?project=nope', tenantA.tokens.admin, 404, 'project_not_found');
      await refused(
        '/v1/cost/report?intent=INT-2026-9999',
        tenantA.tokens.admin,
        404,
        'intent_not_found',
      );
    });
  });

  describe('invalid requests', () => {
    it.each([
      ['/v1/cost/report?project=shop&intent=INT-2026-0001', 'query.intent', 'project_and_intent'],
      ['/v1/cost/report?from=2025-01-01&to=2026-10-01', 'query.to', 'range_too_long'],
      ['/v1/cost/report?from=2026-10-02&to=2026-10-01', 'query.to', 'range_empty'],
    ])('%s → 400 %s %s', async (url, path, issue) => {
      const body = await refused(url, tenantA.tokens.admin, 400, 'invalid_request');
      expect(body.error.details).toEqual([{ path, issue }]);
    });

    it.each([
      '/v1/cost/report?from=2026-10-01T00:00:00%2B09:00',
      '/v1/cost/report?from=2026-02-30',
      '/v1/cost/report?by=agent',
      '/v1/cost/report?tenant=other',
    ])('%s → 400', async (url) => {
      await refused(url, tenantA.tokens.admin, 400, 'invalid_request');
    });
  });
});
