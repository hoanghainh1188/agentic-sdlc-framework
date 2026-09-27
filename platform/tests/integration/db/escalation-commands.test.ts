// D-08 B11 AC5 on a live PostgreSQL (PR 2): acknowledge and decide through the core module, the
// `/ack` and `/decide` comments (same parser, receipts, numeric GitHub IDs, bots ignored), the API
// endpoints, decisions bound to version, scope and expiry (FR-17, Ch.6 §6.6), and the notices
// posted on the intent's issue (design/ADR-M28 §2.4, §2.5, §2.7). Uses the in-process GitHub stub.
import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp, type ApiDeps } from '../../../apps/api/src/app.js';
import { issueApiToken } from '../../../packages/core/src/admin/tokens.js';
import type { Escalation, Intent } from '../../../packages/core/src/db/schema.js';
import type { PollableProject } from '../../../packages/core/src/db/system-scope.js';
import { parseTenantId } from '../../../packages/core/src/db/tenant-id.js';
import type { TenantScope } from '../../../packages/core/src/db/tenant-scope.js';
import {
  acknowledgeEscalation,
  closeEscalation,
  decideEscalation,
  revalidateEscalationDecision,
} from '../../../packages/core/src/escalation/decide.js';
import { EscalationError } from '../../../packages/core/src/escalation/errors.js';
import { checkFreeze } from '../../../packages/core/src/escalation/freeze.js';
import {
  raiseEscalation,
  type RaiseEscalationInput,
} from '../../../packages/core/src/escalation/raise.js';
import { pollProject } from '../../../packages/core/src/git-events/poll-project.js';
import { Registry } from '../../../packages/core/src/registry/registry.js';
import { startHarness, type Harness } from '../../git-github/helpers.js';
import { comment, user } from '../../git-github/stub-github.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

const HASH = 'e'.repeat(64);
const OTHER_HASH = 'f'.repeat(64);
/** The stub's clock: every command and escalation in this file uses it. */
const T0 = new Date('2026-09-26T08:00:00.000Z');
const later = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const clock = { now: () => T0 };

/** Numeric GitHub account IDs (QUESTIONS #45) and logins of the people. */
const GH = {
  a: [2001, 'alice'],
  b: [2002, 'bob'],
  second: [2003, 'carol'],
  gov: [2004, 'gina'],
  viewer: [2005, 'vic'],
} as const;
type Person = keyof typeof GH;
const ROLES = {
  a: 'person_a',
  b: 'person_b',
  second: 'second_approver',
  gov: 'governance',
  viewer: 'viewer',
} as const;

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof EscalationError) return error.code;
    throw error;
  }
  return 'resolved';
}

describeDb('B11 PR 2: acknowledge, decide, comments, API and notices on PostgreSQL', () => {
  let db: TestDatabase;
  let h: Harness;
  let scope: TenantScope;
  let target: PollableProject;
  let registry: Registry;
  let app: Awaited<ReturnType<typeof createApp>>;
  const users = {} as Record<Person, string>;
  const tokens = {} as Record<Person, string>;
  const comments: ReturnType<typeof comment>[] = [];
  let nextCommentId = 500;
  let seconds = 10;
  let issue = 20;

  const posted = (n: number): string[] =>
    h.stub
      .requestsTo('POST', `/repos/acme/shop/issues/${String(n)}/comments`)
      .map((r) => (r.body as { body: string }).body);

  function post(n: number, body: string, who: Person | 'bot' = 'b'): number {
    const id = (nextCommentId += 1);
    seconds += 1;
    const at = new Date(T0.getTime() + seconds * 1000).toISOString().replace('.000Z', 'Z');
    const author =
      who === 'bot' ? user(9999, 'sdlc-bot[bot]', 'Bot') : user(GH[who][0], GH[who][1]);
    comments.push(comment(id, n, at, body, { author }));
    return id;
  }

  const poll = () =>
    pollProject({ db: db.app, gitHost: h.adapter(), registry, now: () => h.stub.now }, target);

  async function receipt(commentId: number): Promise<Record<string, unknown> | undefined> {
    return (
      await sql<Record<string, unknown>>`SELECT * FROM git_event_receipts
        WHERE event_id = ${`github:comment:${String(commentId)}`}`.execute(db.owner)
    ).rows[0];
  }

  /** A new intent on its own issue, so notices and replies of one test never mix. */
  async function newIntent(withIssue = true): Promise<Intent> {
    issue += 1;
    h.stub.on('POST', `/repos/acme/shop/issues/${String(issue)}/comments`, {
      status: 201,
      body: { id: 1 },
    });
    return registry.createIntent(scope, {
      projectId: target.projectId,
      title: 'Cancel an order',
      createdBy: users.a,
      riskTier: 'medium',
      dataClass: 'internal',
      ...(withIssue ? { issueNumber: issue } : {}),
    });
  }

  const raise = (intent: Intent, extra: Partial<RaiseEscalationInput> = {}) =>
    raiseEscalation(
      scope,
      {
        intentId: intent.id,
        trigger: 'out_of_scope',
        route: 'technical',
        severity: 'critical',
        responseLevel: 'pause',
        packet: { subject_kind: 'plan', subject_sha256: HASH, gate: 'G5' },
        producers: [],
        raisedBy: { type: 'system' },
        ...extra,
      },
      clock,
    );

  const reload = async (e: Escalation) => (await scope.escalations.getById(e.id))!;
  const auditActions = async (e: Escalation) =>
    (
      await sql<{ action: string }>`SELECT action FROM audit_log WHERE entity_id = ${e.id}
        ORDER BY seq`.execute(db.owner)
    ).rows.map((r) => r.action);

  beforeAll(async () => {
    db = await createTestDatabase();
    registry = new Registry({
      policyFactory: (config) => createSimplePolicyEngine({ config }),
      now: () => T0,
    });
    const tenant = await db.app.system.createTenant({ slug: 'internal', name: 'Internal' });
    const tenantId = parseTenantId(tenant.id);
    scope = db.app.forTenant(tenantId);
    const project = await scope.projects.create({
      slug: 'shop',
      name: 'Shop',
      git_provider: 'github',
      repo_full_name: 'acme/shop',
    });
    for (const person of Object.keys(GH) as Person[]) {
      const created = await scope.users.create({
        display_name: person,
        email: `${person}@example.com`,
      });
      users[person] = created.id;
      await scope.roleBindings.grant({
        user_id: created.id,
        project_id: project.id,
        role: ROLES[person],
      });
      await scope.userIdentities.link({
        user_id: created.id,
        provider: 'github',
        external_id: String(GH[person][0]),
        external_login: GH[person][1],
      });
      tokens[person] = (
        await issueApiToken(scope, { userId: created.id, name: person, now: T0 })
      ).token;
    }
    target = { tenantId, projectId: project.id, repoFullName: 'acme/shop' };

    h = await startHarness();
    h.stub.now = T0;
    h.stub.on('GET', '/repos/acme/shop', { body: { id: 1 } });
    h.stub.on('GET', '/repos/acme/shop/issues/comments', (req) => ({
      body: comments.filter((c) => Date.parse(c.updated_at) >= Date.parse(req.query.get('since')!)),
    }));
    h.stub.on('GET', '/repos/acme/shop/pulls', { body: [] });
    await poll(); // first poll: no history

    app = await createApp({
      db: db.app as unknown as ApiDeps['db'],
      settings: { rateLimitPerMinute: 1000, authFailuresPerMinute: 1000 },
      now: () => T0,
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await h?.stub.stop();
    await db?.drop();
  });

  describe('acknowledge: owner, backup from its step, governance; never a producer', () => {
    it('refuses the wrong people and records one acknowledgement', async () => {
      const intent = await newIntent();
      const e = await raise(intent, { producers: [users.a] });
      const ack = (who: Person) =>
        acknowledgeEscalation(scope, { escalationId: e.id, actorId: users[who] }, clock);
      expect(await failure(ack('viewer'))).toBe('forbidden');
      expect(await failure(ack('a'))).toBe('forbidden'); // no acting role, and a producer
      expect(await failure(ack('second'))).toBe('forbidden'); // backup role before the backup step
      const acknowledged = await ack('b');
      expect(acknowledged).toMatchObject({ status: 'acknowledged', acknowledged_by: users.b });
      // The acknowledge clock stopped; the resolve clock still runs.
      expect(acknowledged.next_check_at?.toISOString()).toBe(later(60).toISOString());
      expect(await failure(ack('gov'))).toBe('already_acknowledged');
      expect(await auditActions(e)).toEqual(['escalation.created', 'escalation.acknowledged']);
    });

    it('a producer holding the owner role cannot act, governance can', async () => {
      const intent = await newIntent();
      const e = await raise(intent, { producers: [users.b] });
      expect(
        await failure(
          acknowledgeEscalation(scope, { escalationId: e.id, actorId: users.b }, clock),
        ),
      ).toBe('forbidden');
      await acknowledgeEscalation(scope, { escalationId: e.id, actorId: users.gov }, clock);
    });
  });

  describe('decide: bound to version, scope and expiry (FR-17, Ch.6 §6.6)', () => {
    it('resume lets its actions through until expiry; a new version voids it', async () => {
      const intent = await newIntent();
      const e = await raise(intent);
      const decided = await decideEscalation(
        scope,
        {
          escalationId: e.id,
          actorId: users.b,
          decision: 'resume',
          reasonCode: 'budget_exceeded',
          reasonRef: 'https://github.com/acme/shop/issues/1#issuecomment-1',
        },
        clock,
      );
      expect(decided).toMatchObject({
        status: 'resolved',
        acknowledged_by: users.b,
        decided_by: users.b,
        next_check_at: null,
        decision: {
          decision: 'resume',
          subject_sha256: HASH,
          expires_at: '2026-10-03T08:00:00.000Z', // oversight.approval_expiry: 7 days
          reason_code: 'budget_exceeded',
          ref: 'https://github.com/acme/shop/issues/1#issuecomment-1',
          allow_run_resume: true,
        },
      });
      expect((await checkFreeze(scope, intent.id, 'run_resume', later(1))).allowed).toBe(true);
      expect((await checkFreeze(scope, intent.id, 'merge', later(1))).allowed).toBe(false);

      const check = (subject: string, action: 'run_resume' | 'merge', at = later(1)) =>
        revalidateEscalationDecision(
          scope,
          { escalationId: e.id, subjectSha256: subject, action },
          { now: () => at },
        );
      expect(await check(HASH, 'run_resume')).toEqual({ valid: true });
      expect(await check(HASH, 'merge')).toEqual({ valid: false, reason: 'scope_mismatch' });
      expect((await reload(e)).status).toBe('resolved');
      expect(await check(OTHER_HASH, 'run_resume')).toEqual({
        valid: false,
        reason: 'input_mismatch',
      });
      const voided = await reload(e);
      expect(voided).toMatchObject({ status: 'acknowledged', decision: null, decided_by: null });
      expect(voided.resolve_due_at?.toISOString()).toBe(later(61).toISOString());
      expect((await checkFreeze(scope, intent.id, 'run_resume', later(1))).allowed).toBe(false);

      await decideEscalation(
        scope,
        { escalationId: e.id, actorId: users.b, decision: 'resume' },
        clock,
      );
      expect(await check(HASH, 'run_resume', later(8 * 24 * 60))).toEqual({
        valid: false,
        reason: 'expired',
      });
      expect(await auditActions(e)).toEqual([
        'escalation.created',
        'escalation.decided',
        'escalation.decision_voided',
        'escalation.decided',
        'escalation.decision_voided',
      ]);
    });

    it('escalate further moves to governance; governance cannot; close lifts the freeze', async () => {
      const intent = await newIntent();
      const e = await raise(intent);
      const moved = await decideEscalation(
        scope,
        { escalationId: e.id, actorId: users.b, decision: 'escalate_further' },
        clock,
      );
      expect(moved).toMatchObject({ status: 'open', current_step: 'governance', decision: null });
      expect(
        await failure(
          decideEscalation(
            scope,
            { escalationId: e.id, actorId: users.gov, decision: 'escalate_further' },
            clock,
          ),
        ),
      ).toBe('decision_not_allowed');
      await decideEscalation(
        scope,
        { escalationId: e.id, actorId: users.gov, decision: 'terminate' },
        clock,
      );
      expect(
        await failure(
          decideEscalation(
            scope,
            { escalationId: e.id, actorId: users.gov, decision: 'resume' },
            clock,
          ),
        ),
      ).toBe('not_open');
      expect((await checkFreeze(scope, intent.id, 'run_start', later(1))).allowed).toBe(false);
      await closeEscalation(scope, { escalationId: e.id, closedBy: { type: 'system' } }, clock);
      await closeEscalation(scope, { escalationId: e.id, closedBy: { type: 'system' } }, clock);
      expect((await checkFreeze(scope, intent.id, 'run_start', later(1))).allowed).toBe(true);
      expect(await auditActions(e)).toEqual([
        'escalation.created',
        'escalation.escalated_further',
        'escalation.decided',
        'escalation.closed',
      ]);
    });
  });

  describe('/ack and /decide comments (same parser, receipts and identity rules as B06)', () => {
    it('acknowledges and decides by comment; no reply on success; the comment is the ref', async () => {
      const intent = await newIntent();
      const e = await raise(intent);
      const ack = post(issue, '/ack');
      const decide = post(
        issue,
        `/decide ${e.code} resume budget_exceeded\nMore budget, same plan.`,
      );
      await poll();
      expect(await receipt(ack)).toMatchObject({
        outcome: 'acknowledged',
        escalation_id: e.id,
        reply_code: null,
      });
      expect(await receipt(decide)).toMatchObject({ outcome: 'escalation_decided' });
      const row = await reload(e);
      expect(row).toMatchObject({ status: 'resolved', acknowledged_by: users.b });
      expect(row.decision).toMatchObject({
        decision: 'resume',
        reason_code: 'budget_exceeded',
        ref: `https://github.com/acme/shop/issues/${String(issue)}#issuecomment-${String(decide)}`,
      });
      expect(JSON.stringify(row)).not.toContain('More budget');
      expect(posted(issue).filter((b) => b.includes('sdlc-reply'))).toEqual([]);
    });

    it('refuses with a catalog reply: wrong person, unknown code, two open, bad syntax; bots ignored', async () => {
      const intent = await newIntent();
      await raise(intent);
      await raise(intent, { route: 'intent' });
      const bot = post(issue, '/ack', 'bot');
      const ambiguous = post(issue, '/ack', 'b');
      const unknown = post(issue, '/ack ESC-2026-9999', 'b');
      const forbidden = post(issue, '/decide ESC-2026-0001 resume', 'viewer');
      const syntax = post(issue, '/decide maybe', 'b');
      await poll();
      expect(await receipt(bot)).toMatchObject({ outcome: 'ignored_bot', reply_code: null });
      expect(await receipt(ambiguous)).toMatchObject({ reply_code: 'escalation_ambiguous' });
      expect(await receipt(unknown)).toMatchObject({ reply_code: 'escalation_not_found' });
      expect(await receipt(forbidden)).toMatchObject({
        outcome: 'refused',
        reply_code: 'escalation_not_found', // ESC-2026-0001 belongs to another intent
      });
      expect(await receipt(syntax)).toMatchObject({ reply_code: 'syntax_decision_invalid' });
      const replies = posted(issue).filter((b) => b.includes('sdlc-reply'));
      expect(replies).toHaveLength(4);
      expect(replies.some((b) => b.startsWith('/ack: nothing was recorded.'))).toBe(true);
    });

    it('a person without an acting role gets escalation_forbidden', async () => {
      const intent = await newIntent();
      const e = await raise(intent);
      const id = post(issue, `/ack ${e.code}`, 'viewer');
      await poll();
      expect(await receipt(id)).toMatchObject({
        outcome: 'refused',
        escalation_id: e.id,
        reply_code: 'escalation_forbidden',
      });
      expect((await reload(e)).status).toBe('open');
    });
  });

  describe('notices on the intent issue (ADR-M28 §2.5)', () => {
    it('posts one comment per kind, mentioning the holders of the roles; once', async () => {
      const intent = await newIntent();
      const e = await raise(intent);
      await poll();
      const notices = posted(issue).filter((b) => b.includes('sdlc-escalation'));
      expect(notices).toHaveLength(1);
      // Critical: owner role person_b, plus governance, Person A and Person B at once.
      expect(notices[0]).toContain(`**Escalation ${e.code}** (critical, response level pause)`);
      expect(notices[0]).toContain('@alice @bob @gina');
      expect(notices[0]).not.toContain('@vic');
      const rows = await scope.escalationNotices.listForEscalation(e.id);
      expect(rows.every((n) => n.posted_at !== null && n.attempts === 1)).toBe(true);
      await poll();
      expect(posted(issue).filter((b) => b.includes('sdlc-escalation'))).toHaveLength(1);
    });

    it('gives a notice up when the intent has no issue', async () => {
      const intent = await newIntent(false);
      const e = await raise(intent);
      await poll();
      const rows = await scope.escalationNotices.listForEscalation(e.id);
      expect(rows.every((n) => n.abandoned_at !== null && n.posted_at === null)).toBe(true);
    });
  });

  describe('API endpoints', () => {
    const inject = (method: 'GET' | 'POST', url: string, who: Person, body?: unknown) =>
      app
        .getHttpAdapter()
        .getInstance()
        .inject({
          method,
          url,
          headers: { authorization: `Bearer ${tokens[who]}` },
          ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
        });

    it('lists, shows, acknowledges and decides; refuses the wrong person', async () => {
      const intent = await newIntent();
      const e = await raise(intent);
      const list = await inject('GET', `/v1/escalations?intent=${intent.code}`, 'viewer');
      expect(list.statusCode).toBe(200);
      const listed = (list as { json(): unknown }).json() as { items: { code: string }[] };
      expect(listed.items.map((i) => i.code)).toEqual([e.code]);
      const show = await inject('GET', `/v1/escalations/${e.code}`, 'viewer');
      expect(show.json()).toMatchObject({ code: e.code, freezes_intent: true, status: 'open' });

      const refused = await inject('POST', `/v1/escalations/${e.code}/ack`, 'viewer');
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({ error: { code: 'forbidden' } });

      const ack = await inject('POST', `/v1/escalations/${e.code}/ack`, 'b');
      expect(ack.statusCode).toBe(200);
      expect((await inject('POST', `/v1/escalations/${e.code}/ack`, 'b')).statusCode).toBe(409);

      const bad = await inject('POST', `/v1/escalations/${e.code}/decisions`, 'b', {
        decision: 'resume',
        reason: 'free text is not accepted',
      });
      expect(bad.statusCode).toBe(400);
      const decided = await inject('POST', `/v1/escalations/${e.code}/decisions`, 'b', {
        decision: 'modify',
        actions: ['gate_advance'],
      });
      expect(decided.statusCode).toBe(201);
      expect(decided.json()).toMatchObject({
        status: 'resolved',
        decision: { decision: 'modify', allow_gate_advance: true },
      });
      expect((await inject('GET', '/v1/escalations/ESC-2026-99999', 'b')).statusCode).toBe(404);
      expect((await inject('GET', '/v1/escalations/INT-2026-0001', 'b')).statusCode).toBe(400);
    });
  });
});
