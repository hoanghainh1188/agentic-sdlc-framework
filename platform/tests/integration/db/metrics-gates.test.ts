// D-08 E06 on a live PostgreSQL, through the Nest app and Fastify `inject()` (no port). The intents
// move through G1–G3 with the real workflow step and gate commands, so `waited_seconds`, the visits
// and the audit chain are what the platform writes.
// - AC1: average and maximum waiting time (plus count, median, p90) per gate and project.
// - QUESTIONS #205: people's decisions only, split into the first round and after a request for
//   changes in the same visit; HOTL passes counted apart (`auto_passed`); a block of a passed gate
//   (no `waited_seconds`) left out.
// - QUESTIONS #207: intents at the gate now, every gate, never in the statistics.
// - The range (half-open, on the decision's audit time), the gate, mode and risk filters.
// - QUESTIONS #206: tenant admin for the whole tenant, `access.metrics_read_roles` for a project,
//   viewer 403, no role 404; another tenant's decisions never counted.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp, type ApiDeps } from '../../../apps/api/src/app.js';
import { issueApiToken } from '../../../packages/core/src/admin/tokens.js';
import {
  decideGate,
  type CommandDecision,
} from '../../../packages/core/src/commands/gate-command.js';
import type { Intent } from '../../../packages/core/src/db/schema.js';
import type { TenantScope } from '../../../packages/core/src/db/tenant-scope.js';
import { parseTenantId } from '../../../packages/core/src/db/tenant-id.js';
import { stepIntent } from '../../../packages/core/src/workflow/step.js';
import { seedAiRecord } from '../ai-record-seed.js';
import { createWorkflowFixture, type WorkflowFixture } from '../workflow/fixture.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

type App = Awaited<ReturnType<typeof createApp>>;
const asApiDb = (db: TestDatabase): ApiDeps['db'] => db.app as unknown as ApiDeps['db'];

// Monday 08:00 in Ho Chi Minh City, before the working day (the default calendar).
const T0 = new Date('2026-09-28T01:00:00.000Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (ms: number) => new Date(T0.getTime() + ms);
/** The API's clock: six days later, inside the default range (the last 30 days). */
const NOW = new Date('2026-10-04T09:00:00.000Z');
const since = (d: Date) => Math.floor((NOW.getTime() - d.getTime()) / 1000);

type Who = 'admin' | 'a' | 'b' | 'pm' | 'viewer' | 'outsider';

interface Stats {
  readonly count: number;
  readonly avg_seconds: number | null;
  readonly max_seconds: number | null;
  readonly p50_seconds: number | null;
  readonly p90_seconds: number | null;
}
interface Row {
  readonly project: string;
  readonly gate: string;
  readonly first_round: Stats;
  readonly after_changes: Stats;
  readonly auto_passed: number;
  readonly open: { readonly count: number; readonly oldest_seconds: number | null };
}
interface Metrics {
  readonly scope: Record<string, string>;
  readonly from: string;
  readonly to: string;
  readonly as_of: string;
  readonly clock: string;
  readonly filters: Record<string, string | null>;
  readonly rows: readonly Row[];
  readonly truncated: boolean;
}

const none = {
  count: 0,
  avg_seconds: null,
  max_seconds: null,
  p50_seconds: null,
  p90_seconds: null,
};
const one = (s: number) => ({
  count: 1,
  avg_seconds: s,
  max_seconds: s,
  p50_seconds: s,
  p90_seconds: s,
});

describeDb('E06: gate waiting-time metrics on PostgreSQL', () => {
  let db: TestDatabase;
  let f: WorkflowFixture;
  let app: App;
  let clock = T0;
  const tokens = {} as Record<Who, string>;
  let otherAdmin = '';
  /** When the intents still waiting entered their gate. */
  const entered: Record<string, Date> = {};

  const step = (scope: TenantScope, intent: Intent) =>
    stepIntent(scope, { registry: f.registry }, intent.id);
  async function settle(scope: TenantScope, intent: Intent): Promise<void> {
    for (let i = 0; i < 12; i += 1) {
      if ((await step(scope, intent)).outcome !== 'moved') return;
    }
    throw new Error('the step never settled');
  }
  const reload = async (scope: TenantScope, intent: Intent) =>
    (await scope.intents.getById(intent.id))!;
  const decide = (
    scope: TenantScope,
    intent: Intent,
    gate: string,
    decision: CommandDecision,
    actorId: string,
  ) =>
    decideGate(f.registry, scope, {
      intent,
      gate,
      decision,
      actorId,
      reasonCode: decision === 'approve' ? null : 'tests_insufficient',
      source: 'cli',
    });
  const setClock = (d: Date) => {
    clock = d;
    f.h.stub.now = d;
  };

  const inject = async (url: string, who: string) =>
    await app
      .getHttpAdapter()
      .getInstance()
      .inject({ method: 'GET', url, headers: { authorization: `Bearer ${who}` } });
  const metrics = async (url: string, who: string): Promise<Metrics> => {
    const reply = await inject(url, who);
    expect(reply.statusCode, reply.body).toBe(200);
    return reply.json<{ metrics: Metrics }>().metrics;
  };
  const refused = async (url: string, who: string, status: number, code: string) => {
    const reply = await inject(url, who);
    expect(reply.statusCode, reply.body).toBe(status);
    expect(reply.json<{ error: { code: string } }>().error.code).toBe(code);
    return reply.json<{ error: { details?: { path: string; issue: string }[] } }>();
  };
  const row = (m: Metrics, project: string, gate: string) =>
    m.rows.find((r) => r.project === project && r.gate === gate);

  beforeAll(async () => {
    db = await createTestDatabase();
    f = await createWorkflowFixture(db, () => clock);
    setClock(T0);
    const { scope } = f;
    const shop = (await scope.projects.getBySlug('shop'))!;

    // People of the report (QUESTIONS #206).
    const roles: Record<Exclude<Who, 'a' | 'b'>, string | null> = {
      admin: null,
      pm: 'pm_brse',
      viewer: 'viewer',
      outsider: null,
    };
    const ids: Record<Who, string> = { a: f.users.a, b: f.users.b } as Record<Who, string>;
    for (const [who, role] of Object.entries(roles) as [Who, string | null][]) {
      ids[who] = (await scope.users.create({ display_name: who, email: `${who}@example.com` })).id;
      if (role) {
        await scope.roleBindings.grant({
          user_id: ids[who],
          project_id: shop.id,
          role: role as 'pm_brse',
        });
      }
    }
    await scope.tenantRoles.grant({ user_id: ids.admin, role: 'tenant_admin' });
    for (const who of Object.keys(ids) as Who[]) {
      tokens[who] = (await issueApiToken(scope, { userId: ids[who], name: who, now: NOW })).token;
    }

    // X1 (Medium): G1 after 1 h, G2 after 2 h, G3: changes asked after 1 h, approved 3 h later.
    const x1 = await f.newIntent({ riskTier: 'medium' });
    await settle(scope, x1);
    setClock(at(HOUR));
    await decide(scope, await reload(scope, x1), 'G1', 'approve', f.users.a);
    await settle(scope, x1);
    await f.addInputs(await reload(scope, x1));
    setClock(at(3 * HOUR));
    await decide(scope, await reload(scope, x1), 'G2', 'approve', f.users.a);
    await settle(scope, x1);
    setClock(at(4 * HOUR));
    await decide(scope, await reload(scope, x1), 'G3', 'request_changes', f.users.b);
    await settle(scope, x1);
    // Paused and resumed at the same gate (an escalation): `gate_entered_at` keeps running, so
    // the approval below is still after changes, not a new first round.
    setClock(at(5 * HOUR));
    const g3 = { status: 'in_gate' as const, currentGate: 'G3' as const };
    const paused = { status: 'paused' as const, currentGate: 'G3' as const };
    expect(await scope.intents.moveState(x1.id, { from: g3, to: paused, at: clock })).toBeDefined();
    expect(await scope.intents.moveState(x1.id, { from: paused, to: g3, at: clock })).toBeDefined();
    setClock(at(6 * HOUR));
    await f.registry.submitPlan(scope, x1.id, {
      plannedFiles: ['apps/api/src/orders/**'],
      planSha256: '7'.repeat(64),
      changeFlags: [],
      actorType: 'human',
      actorId: f.users.a,
    });
    await settle(scope, x1);
    setClock(at(7 * HOUR));
    await decide(scope, await reload(scope, x1), 'G3', 'approve', f.users.b);
    await settle(scope, x1);
    expect(await reload(scope, x1)).toMatchObject({ status: 'in_gate', current_gate: 'G4' });

    // X2 (Low): G1 after 30 min; G2 and G3 pass by HOTL; Person B blocks G3 within the window
    // (no `waited_seconds`), so the intent is back at G3.
    setClock(T0);
    const x2 = await f.newIntent({ riskTier: 'low' });
    await settle(scope, x2);
    setClock(at(30 * MIN));
    await decide(scope, await reload(scope, x2), 'G1', 'approve', f.users.a);
    await f.addInputs(await reload(scope, x2));
    await settle(scope, x2);
    expect(await reload(scope, x2)).toMatchObject({ current_gate: 'G4' });
    setClock(at(2 * HOUR));
    await decide(scope, await reload(scope, x2), 'G3', 'request_changes', f.users.b);
    await settle(scope, x2);
    expect(await reload(scope, x2)).toMatchObject({ status: 'in_gate', current_gate: 'G3' });
    // Back at G3: a new visit. Person B approves explicitly 30 min later: a first round, because
    // the block was recorded before the intent came back (the clock restarted at the return).
    setClock(at(2 * HOUR + 30 * MIN));
    await decide(scope, await reload(scope, x2), 'G3', 'approve', f.users.b);
    await settle(scope, x2);
    expect(await reload(scope, x2)).toMatchObject({ status: 'in_gate', current_gate: 'G4' });
    entered['x2'] = at(2 * HOUR + 30 * MIN);

    // X3 (Medium): waits at G1, nobody decided yet.
    setClock(at(5 * HOUR));
    const x3 = await f.newIntent({ riskTier: 'medium' });
    await settle(scope, x3);
    entered['x3'] = at(5 * HOUR);

    // A second project of the tenant: one intent waiting at G1.
    const ops = await scope.projects.create({
      slug: 'ops',
      name: 'Ops',
      git_provider: 'github',
      repo_full_name: 'acme/ops',
    });
    await scope.roleBindings.grant({ user_id: f.users.a, project_id: ops.id, role: 'person_a' });
    await seedAiRecord(scope, ops.id, f.users.a);
    const opsIntent = await f.registry.createIntent(scope, {
      projectId: ops.id,
      title: 'Rotate logs',
      createdBy: f.users.a,
      riskTier: 'medium',
      dataClass: 'internal',
    });
    await settle(scope, opsIntent);
    entered['ops'] = at(5 * HOUR);

    // Another tenant: one G1 approval that must never be counted for this tenant.
    const tenantB = await db.app.system.createTenant({ slug: 'other', name: 'Other' });
    const other = db.app.forTenant(parseTenantId(tenantB.id));
    const otherShop = await other.projects.create({
      slug: 'shop',
      name: 'Shop',
      git_provider: 'github',
      repo_full_name: 'other/shop',
    });
    const otherA = await other.users.create({ display_name: 'a', email: 'a@other.example.com' });
    await other.roleBindings.grant({
      user_id: otherA.id,
      project_id: otherShop.id,
      role: 'person_a',
    });
    await other.tenantRoles.grant({ user_id: otherA.id, role: 'tenant_admin' });
    await seedAiRecord(other, otherShop.id, otherA.id);
    setClock(T0);
    const y = await f.registry.createIntent(other, {
      projectId: otherShop.id,
      title: 'Other work',
      createdBy: otherA.id,
      riskTier: 'medium',
      dataClass: 'internal',
    });
    await settle(other, y);
    setClock(at(9 * HOUR));
    await decide(other, await reload(other, y), 'G1', 'approve', otherA.id);
    await settle(other, y);
    otherAdmin = (await issueApiToken(other, { userId: otherA.id, name: 'a', now: NOW })).token;

    app = await createApp({
      db: asApiDb(db),
      settings: { rateLimitPerMinute: 1000, authFailuresPerMinute: 1000 },
      now: () => NOW,
      logger: { error: () => undefined },
    });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await f?.close();
    await db?.drop();
  });

  describe('AC1: per project and gate', () => {
    it('a project: count, average, maximum, median and p90 of people’s decisions, by round', async () => {
      const m = await metrics('/v1/metrics/gates?project=shop', tokens.a);
      expect(m.scope).toEqual({ kind: 'project', project: 'shop' });
      expect(m.from).toBe('2026-09-04T09:00:00.000Z');
      expect(m.to).toBe(NOW.toISOString());
      expect(m.as_of).toBe(NOW.toISOString());
      expect(m.clock).toBe('wall_clock');
      expect(m.truncated).toBe(false);
      expect(m.rows.map((r) => r.gate)).toEqual(['G1', 'G2', 'G3', 'G4']);
      // G1: X1 after 1 h, X2 after 30 min; X3 still waiting (never in the statistics).
      expect(row(m, 'shop', 'G1')).toEqual({
        project: 'shop',
        gate: 'G1',
        first_round: {
          count: 2,
          avg_seconds: 2700,
          max_seconds: 3600,
          p50_seconds: 1800,
          p90_seconds: 3600,
        },
        after_changes: none,
        auto_passed: 0,
        open: { count: 1, oldest_seconds: since(entered['x3']!) },
      });
      // G2: X1 after 2 h; X2 passed by the platform (HOTL).
      expect(row(m, 'shop', 'G2')).toMatchObject({
        first_round: one(7200),
        after_changes: none,
        auto_passed: 1,
        open: { count: 0, oldest_seconds: null },
      });
      // G3: X1's request for changes ended its first round (1 h); X2's explicit approval after it
      // came back is a first round too (30 min). X1's approval after the request is apart (4 h
      // since the entry, the rework and a pause included). X2's HOTL pass counts; its block does not.
      expect(row(m, 'shop', 'G3')).toMatchObject({
        first_round: {
          count: 2,
          avg_seconds: 2700,
          max_seconds: 3600,
          p50_seconds: 1800,
          p90_seconds: 3600,
        },
        after_changes: one(4 * 3600),
        auto_passed: 1,
        open: { count: 0, oldest_seconds: null },
      });
      // G4: no decision by a person, no platform pass counted (POLICY is automatic): X1 and X2 now.
      expect(row(m, 'shop', 'G4')).toEqual({
        project: 'shop',
        gate: 'G4',
        first_round: none,
        after_changes: none,
        auto_passed: 0,
        open: { count: 2, oldest_seconds: since(entered['x2']!) },
      });
    });

    it('the whole tenant (tenant admin): one row per project and gate, never another tenant', async () => {
      const m = await metrics('/v1/metrics/gates', tokens.admin);
      expect(m.scope).toEqual({ kind: 'tenant' });
      expect(m.rows.map((r) => `${r.project}/${r.gate}`)).toEqual([
        'ops/G1',
        'shop/G1',
        'shop/G2',
        'shop/G3',
        'shop/G4',
      ]);
      expect(row(m, 'ops', 'G1')).toMatchObject({
        first_round: none,
        open: { count: 1, oldest_seconds: since(entered['ops']!) },
      });
      // The other tenant's G1 approval (9 h) is not in this tenant's statistics.
      expect(row(m, 'shop', 'G1')?.first_round.max_seconds).toBe(3600);
      const b = await metrics('/v1/metrics/gates', otherAdmin);
      expect(b.rows).toEqual([
        expect.objectContaining({
          gate: 'G1',
          first_round: one(9 * 3600),
          open: { count: 0, oldest_seconds: null },
        }),
        {
          project: 'shop',
          gate: 'G2',
          first_round: none,
          after_changes: none,
          auto_passed: 0,
          open: { count: 1, oldest_seconds: since(at(9 * HOUR)) },
        },
      ]);
    });
  });

  describe('filters and range', () => {
    it('the range is half-open on the time the decision was recorded', async () => {
      // X2's G1 at 01:30 is in; X1's G1 at exactly 02:00 is out.
      const m = await metrics(
        '/v1/metrics/gates?project=shop&from=2026-09-28&to=2026-09-28T02:00:00Z',
        tokens.a,
      );
      expect(m.from).toBe('2026-09-28T00:00:00.000Z');
      expect(row(m, 'shop', 'G1')?.first_round).toEqual(one(1800));
      // Open waits are always now: the range does not apply to them.
      expect(row(m, 'shop', 'G4')?.open.count).toBe(2);
      const later = await metrics('/v1/metrics/gates?project=shop&from=2026-09-29', tokens.a);
      expect(later.rows.every((r) => r.first_round.count === 0 && r.auto_passed === 0)).toBe(true);
    });

    it('--gate, --risk and --mode narrow the rows', async () => {
      const g3 = await metrics('/v1/metrics/gates?project=shop&gate=G3', tokens.a);
      expect(g3.filters).toEqual({ gate: 'G3', mode: null, risk: null });
      expect(g3.rows.map((r) => r.gate)).toEqual(['G3']);

      const low = await metrics('/v1/metrics/gates?project=shop&risk=low', tokens.a);
      expect(low.rows.map((r) => r.gate)).toEqual(['G1', 'G2', 'G3', 'G4']);
      expect(row(low, 'shop', 'G1')?.first_round).toEqual(one(1800));
      expect(row(low, 'shop', 'G1')?.open.count).toBe(0);
      expect(row(low, 'shop', 'G3')).toMatchObject({
        first_round: one(1800),
        after_changes: none,
        auto_passed: 1,
      });
      expect(row(low, 'shop', 'G4')?.open).toEqual({
        count: 1,
        oldest_seconds: since(entered['x2']!),
      });

      const hotl = await metrics('/v1/metrics/gates?project=shop&mode=HOTL', tokens.a);
      expect(row(hotl, 'shop', 'G2')).toMatchObject({ first_round: none, auto_passed: 1 });
      expect(row(hotl, 'shop', 'G1')).toMatchObject({ first_round: none, auto_passed: 0 });
      const hitl = await metrics('/v1/metrics/gates?project=shop&mode=HITL', tokens.a);
      expect(row(hitl, 'shop', 'G3')).toMatchObject({
        after_changes: one(4 * 3600),
        auto_passed: 0,
      });
    });

    it.each([
      ['from=2026-10-04T09:00:00Z', 'range_empty'],
      ['from=2025-01-01', 'range_too_long'],
    ])('a bad range (%s) is refused with 400 %s', async (query, issue) => {
      const body = await refused(
        `/v1/metrics/gates?${query}`,
        tokens.admin,
        400,
        'invalid_request',
      );
      expect(body.error.details).toEqual([{ path: 'query.to', issue }]);
    });

    it.each(['gate=G9', 'mode=auto', 'risk=extreme', 'by=person', 'from=yesterday'])(
      'an unknown parameter or value (%s) is refused with 400',
      async (query) => {
        await refused(`/v1/metrics/gates?${query}`, tokens.admin, 400, 'invalid_request');
      },
    );
  });

  describe('who may read them (QUESTIONS #206)', () => {
    it('PM / BrSE (in the default metrics_read_roles) reads the project', async () => {
      await metrics('/v1/metrics/gates?project=shop', tokens.pm);
    });

    it('the viewer is refused (403), someone without a role does not see the project (404)', async () => {
      await refused('/v1/metrics/gates?project=shop', tokens.viewer, 403, 'forbidden');
      await refused('/v1/metrics/gates?project=shop', tokens.outsider, 404, 'project_not_found');
      await refused('/v1/metrics/gates?project=nope', tokens.a, 404, 'project_not_found');
    });

    it('the whole tenant needs a tenant admin', async () => {
      await refused('/v1/metrics/gates', tokens.a, 403, 'forbidden');
      await refused('/v1/metrics/gates', tokens.b, 403, 'forbidden');
    });

    it('a tenant admin of another tenant never sees this tenant’s project', async () => {
      // `shop` exists in both tenants: the other tenant's admin reads its own `shop` only.
      const m = await metrics('/v1/metrics/gates?project=shop', otherAdmin);
      expect(m.rows.map((r) => r.gate)).toEqual(['G1', 'G2']);
      await refused('/v1/metrics/gates?project=ops', otherAdmin, 404, 'project_not_found');
    });
  });

  // S01 (ADR-M61): the system `fail spec_unclear` at G2 is a check of the input, never a person's
  // wait nor a platform pass: it changes no statistic; the intent counts as open at G2.
  describe('S01: a G2 fail spec_unclear is never counted', () => {
    it('leaves the first round, the after-changes round and auto_passed unchanged', async () => {
      const url = '/v1/metrics/gates?project=shop&gate=G2';
      const before = row(await metrics(url, tokens.a), 'shop', 'G2');
      setClock(at(8 * HOUR));
      const x5 = await f.newIntent({ riskTier: 'low' });
      await settle(f.scope, x5);
      await decide(f.scope, await reload(f.scope, x5), 'G1', 'approve', f.users.a);
      await settle(f.scope, x5);
      await f.registry.linkSpec(f.scope, x5.id, {
        path: 'docs/specs/t11.md',
        commitSha: 'c'.repeat(40),
        contentSha256: 'd'.repeat(64),
        structure: 'none',
        acceptanceCriteria: 0,
        actorType: 'human',
        actorId: f.users.a,
      });
      await settle(f.scope, x5);
      expect(
        (await f.scope.gateDecisions.listForIntent(x5.id, 'G2')).map((d) => [
          d.decision,
          d.reason_code,
          d.actor_type,
        ]),
      ).toEqual([['fail', 'spec_unclear', 'system']]);
      const after = row(await metrics(url, tokens.a), 'shop', 'G2');
      expect(after).toMatchObject({
        first_round: before?.first_round,
        after_changes: before?.after_changes,
        auto_passed: before?.auto_passed,
      });
      expect(after?.open.count).toBe((before?.open.count ?? 0) + 1);
    });
  });
});
