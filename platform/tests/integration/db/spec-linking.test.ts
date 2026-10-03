// D-08 B08 on a live PostgreSQL (design/ADR-M39, QUESTIONS #160–#163, D-09 scenario N4):
// - AC1: a spec is linked by path (and optionally a commit) through the API; the platform reads the
//   file from the Git host and stores its SHA-256 only; who may link comes from
//   `access.spec_link_roles`; a commit must hold the same content as the default branch's head.
// - AC2: before G3 and before the run (the step at G2, G3 and G4) the spec is checked again at the
//   head of the default branch: a change takes the intent back to G2 with a notice, and approvals
//   of the old spec are voided (FR-17); an unreadable spec takes it back to G2, where it waits; a
//   Git host that cannot be read makes the step wait, never pass.
// The Git host is an in-memory fake: these tests are about the platform's rules, and
// `platform/tests/specs/spec-rules.test.ts` covers reading through the real GitHub adapter.
import { createHash } from 'node:crypto';

import { t, type MessageKey } from '@sdlc/messages';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp, type ApiDeps } from '../../../apps/api/src/app.js';
import { issueApiToken } from '../../../packages/core/src/admin/tokens.js';
import {
  decideGate,
  type CommandDecision,
} from '../../../packages/core/src/commands/gate-command.js';
import type { Intent } from '../../../packages/core/src/db/schema.js';
import { linkSpecFromGitHost } from '../../../packages/core/src/specs/link.js';
import { stepIntent, type StepDeps } from '../../../packages/core/src/workflow/step.js';
import { FakeSpecGitHost as FakeGitHost, SPEC_PATH, SPEC_TEXT } from '../fake-spec-git-host.js';
import { createWorkflowFixture, PLAN_HASH, type WorkflowFixture } from '../workflow/fixture.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

const NOW = new Date('2026-09-28T01:00:00.000Z');
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

interface Reply {
  readonly statusCode: number;
  json(): Record<string, unknown> & {
    readonly error?: { readonly code: string; readonly message: string; readonly reason?: string };
  };
}

describeDb('B08: spec linking and the spec hash check on PostgreSQL', () => {
  let db: TestDatabase;
  let f: WorkflowFixture;
  let git: FakeGitHost;
  let app: Awaited<ReturnType<typeof createApp>>;
  const tokens: Record<'a' | 'b' | 'pm' | 'viewer' | 'outsider', string> = {} as never;
  const users: Record<'pm' | 'viewer' | 'outsider', string> = {} as never;

  const deps = (): StepDeps => ({ registry: f.registry, specs: { gitHost: git } });
  const step = (intent: Intent) => stepIntent(f.scope, deps(), intent.id);
  const settle = async (intent: Intent) => {
    for (let i = 0; i < 12; i += 1) {
      const result = await step(intent);
      if (result.outcome !== 'moved') return result;
    }
    throw new Error('the step never settled');
  };
  const reload = async (intent: Intent) => (await f.scope.intents.getById(intent.id))!;
  const decide = async (intent: Intent, gate: string, decision: CommandDecision, who: 'a' | 'b') =>
    decideGate(f.registry, f.scope, {
      intent: await reload(intent),
      gate,
      decision,
      actorId: f.users[who],
      reasonCode: decision === 'approve' ? null : 'spec_unclear',
      source: 'cli',
    });
  const link = (intent: Intent, path = SPEC_PATH) =>
    linkSpecFromGitHost(f.scope, { gitHost: git }, { intent, path, actorId: f.users.a });
  const plan = (intent: Intent) =>
    f.registry.submitPlan(f.scope, intent.id, {
      plannedFiles: ['apps/api/src/orders/**'],
      planSha256: PLAN_HASH,
      changeFlags: [],
      actorType: 'human',
      actorId: f.users.a,
    });
  const notices = async (intent: Intent) =>
    (await f.scope.intentNotices.listForIntent(intent.id)).map((n) => [
      n.kind,
      n.gate,
      n.previous_gate,
    ]);

  const inject = async (
    method: 'GET' | 'POST',
    url: string,
    token: string,
    body?: Record<string, unknown>,
  ): Promise<Reply> =>
    await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method,
        url,
        headers: { authorization: `Bearer ${token}` },
        ...(body === undefined ? {} : { payload: body }),
      });
  const expectError = (reply: Reply, status: number, code: string, reason?: string) => {
    expect(reply.statusCode, JSON.stringify(reply.json())).toBe(status);
    expect(reply.json().error?.code).toBe(code);
    expect(reply.json().error?.message).toBe(t(`api.error.${code}` as MessageKey));
    if (reason !== undefined) expect(reply.json().error?.reason).toBe(reason);
  };

  /** A Medium intent at G2 (G1 approved by Person A). */
  async function atG2(riskTier: 'low' | 'medium' = 'medium'): Promise<Intent> {
    const intent = await f.newIntent({ riskTier });
    await settle(intent);
    await decide(intent, 'G1', 'approve', 'a');
    await settle(intent);
    expect(await reload(intent)).toMatchObject({ current_gate: 'G2' });
    return intent;
  }

  /** A Medium intent at G3: spec linked, G2 approved by Person A, plan submitted. */
  async function atG3(): Promise<Intent> {
    const intent = await atG2();
    await link(intent);
    await decide(intent, 'G2', 'approve', 'a');
    await plan(intent);
    await settle(intent);
    expect(await reload(intent)).toMatchObject({ status: 'in_gate', current_gate: 'G3' });
    return intent;
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    f = await createWorkflowFixture(db, () => NOW);
    f.h.stub.now = NOW;
    git = new FakeGitHost();
    const extra = { pm: 'pm_brse', viewer: 'viewer', outsider: null } as const;
    for (const [key, role] of Object.entries(extra) as [keyof typeof extra, string | null][]) {
      const user = await f.scope.users.create({ display_name: key, email: `${key}@example.com` });
      users[key] = user.id;
      if (role) {
        await f.scope.roleBindings.grant({
          user_id: user.id,
          project_id: f.target.projectId,
          role: role as 'pm_brse' | 'viewer',
        });
      }
    }
    const ids = { a: f.users.a, b: f.users.b, ...users };
    for (const [key, userId] of Object.entries(ids) as [keyof typeof tokens, string][]) {
      tokens[key] = (await issueApiToken(f.scope, { userId, name: key, now: NOW })).token;
    }
    app = await createApp({
      db: db.app as unknown as ApiDeps['db'],
      settings: { rateLimitPerMinute: 1000, authFailuresPerMinute: 1000 },
      now: () => NOW,
      gitHost: git,
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await f?.close();
    await db?.drop();
  });

  describe('AC1: linking a spec (API, QUESTIONS #160, #162)', () => {
    it('reads the file at the head of the default branch and stores its SHA-256 only', async () => {
      git.down = false;
      const intent = await atG2();
      const reply = await inject('POST', `/v1/intents/${intent.code}/specs`, tokens.a, {
        path: SPEC_PATH,
        source_tool: 'manual',
      });
      expect(reply.statusCode, JSON.stringify(reply.json())).toBe(201);
      const text = '# T07 Cancel an order\nAC1: stock returns.\n';
      expect(reply.json()).toEqual({
        intent: intent.code,
        version: 1,
        path: SPEC_PATH,
        commit_sha: git.head,
        content_sha256: sha256(text),
      });
      // Only the path, the commit and the hash: the content never reaches the database.
      const dump = JSON.stringify(
        (await sql`SELECT * FROM spec_refs WHERE intent_id = ${intent.id}`.execute(db.owner)).rows,
      );
      expect(dump).not.toContain('Cancel an order');
      const audit = await f.scope.audit.listForEntity(intent.id, ['spec.linked']);
      const linked = (await f.scope.specRefs.latest(intent.id))!;
      expect(audit.at(-1)?.payload).toEqual({
        spec_ref_id: linked.id,
        version: 1,
        content_sha256: sha256(text),
        commit_sha: git.head,
        cause: 'linked',
      });
      expect(JSON.stringify(audit)).not.toContain(SPEC_PATH);

      // The same path and content again: no new version.
      const again = await inject('POST', `/v1/intents/${intent.code}/specs`, tokens.a, {
        path: SPEC_PATH,
      });
      expect(again.json()).toMatchObject({ version: 1 });
      const list = await inject('GET', `/v1/intents/${intent.code}/specs`, tokens.b);
      expect(list.statusCode).toBe(200);
      expect(list.json()).toMatchObject({ intent: intent.code, items: [{ version: 1 }] });
    });

    it('who may link: spec_link_roles (Person A, PM / BrSE); a read role → 403; no role → 404', async () => {
      const intent = await atG2();
      const url = `/v1/intents/${intent.code}/specs`;
      expect((await inject('POST', url, tokens.pm, { path: SPEC_PATH })).statusCode).toBe(201);
      expectError(await inject('POST', url, tokens.b, { path: SPEC_PATH }), 403, 'forbidden');
      expectError(await inject('POST', url, tokens.viewer, { path: SPEC_PATH }), 403, 'forbidden');
      expectError(
        await inject('POST', url, tokens.outsider, { path: SPEC_PATH }),
        404,
        'intent_not_found',
      );
      expectError(await inject('GET', url, tokens.outsider), 404, 'intent_not_found');
    });

    it('a commit must hold the same content as the head of the default branch (409 otherwise)', async () => {
      const intent = await atG2();
      const url = `/v1/intents/${intent.code}/specs`;
      const same = git.head;
      git.commit({ 'README.md': 'unrelated' });
      const ok = await inject('POST', url, tokens.a, { path: SPEC_PATH, commit_sha: same });
      expect(ok.statusCode, JSON.stringify(ok.json())).toBe(201);
      expect(ok.json()).toMatchObject({ commit_sha: same });

      git.commit({ [SPEC_PATH]: '# T07 Cancel an order\nAC1: stock returns at once.\n' });
      expectError(
        await inject('POST', url, tokens.a, { path: SPEC_PATH, commit_sha: same }),
        409,
        'spec_not_on_default_branch',
      );
      git.commit({ [SPEC_PATH]: '# T07 Cancel an order\nAC1: stock returns.\n' });
    });

    it('refuses a path that is not Markdown, a file that cannot be read, and answers 503 when GitHub is down', async () => {
      const intent = await atG2();
      const url = `/v1/intents/${intent.code}/specs`;
      expectError(
        await inject('POST', url, tokens.a, { path: 'docs/specs/T07.txt' }),
        422,
        'spec_invalid',
        'invalid_path',
      );
      expectError(
        await inject('POST', url, tokens.a, { path: '../T07.md' }),
        422,
        'spec_invalid',
        'invalid_path',
      );
      const missing = await inject('POST', url, tokens.a, { path: 'docs/specs/none.md' });
      expectError(missing, 422, 'spec_invalid', 'missing');
      git.down = true;
      try {
        expectError(
          await inject('POST', url, tokens.a, { path: SPEC_PATH }),
          503,
          'git_host_unavailable',
        );
      } finally {
        git.down = false;
      }
      expect(await f.scope.specRefs.list(intent.id)).toEqual([]);
    });

    it('a rejected intent takes no spec (409)', async () => {
      const intent = await f.newIntent({ riskTier: 'medium' });
      await settle(intent);
      await decide(intent, 'G1', 'reject', 'a');
      await settle(intent);
      expectError(
        await inject('POST', `/v1/intents/${intent.code}/specs`, tokens.a, { path: SPEC_PATH }),
        409,
        'spec_link_not_allowed',
      );
    });
  });

  describe('AC2: the spec is checked again before G3 and before the run (N4)', () => {
    it('the spec changed on the default branch while at G3: back to G2, new version, old approvals void', async () => {
      const intent = await atG3();
      const edited = '# T07 Cancel an order\nAC1: stock returns.\nAC2: refund.\n';
      const head = git.commit({ [SPEC_PATH]: edited });

      expect(await step(intent)).toEqual({ outcome: 'moved' });
      expect(await reload(intent)).toMatchObject({ status: 'in_gate', current_gate: 'G2' });
      const specs = await f.scope.specRefs.list(intent.id);
      expect(specs.at(-1)).toMatchObject({
        version: 2,
        path: SPEC_PATH,
        commit_sha: head,
        content_sha256: sha256(edited),
      });
      const audit = await f.scope.audit.listForEntity(intent.id, ['spec.linked']);
      expect(audit.at(-1)).toMatchObject({
        actor_type: 'system',
        payload: expect.objectContaining({ cause: 'head_changed', commit_sha: head }) as unknown,
      });
      expect((await notices(intent)).at(-1)).toEqual(['spec_changed', 'G2', 'G3']);

      // At G2 the approval of the old spec is voided (FR-17), and the gate waits for a person.
      expect(await settle(intent)).toMatchObject({ outcome: 'waiting', reason: 'decision' });
      const g2 = await f.scope.gateDecisions.listForIntent(intent.id, 'G2');
      expect(g2.map((d) => [d.decision, d.reason_code])).toEqual([
        ['approve', null],
        ['void', 'input_mismatch'],
      ]);
      await decide(intent, 'G2', 'approve', 'a');
      await settle(intent);
      expect(await reload(intent)).toMatchObject({ current_gate: 'G3' });
      expect((await f.scope.gateDecisions.listForIntent(intent.id, 'G2')).at(-1)).toMatchObject({
        decision: 'approve',
        input_sha256: sha256(edited),
      });
    });

    it('Low risk at G4: the changed spec goes back to G2 and HOTL passes it again (QUESTIONS #161)', async () => {
      const intent = await atG2('low');
      await link(intent);
      await plan(intent);
      expect(await settle(intent)).toMatchObject({ reason: 'later_gate' });
      expect(await reload(intent)).toMatchObject({ current_gate: 'G4' });

      const edited = '# T07 Cancel an order\nAC1: stock returns (low).\n';
      git.commit({ [SPEC_PATH]: edited });
      await settle(intent);
      expect(await reload(intent)).toMatchObject({ status: 'in_gate', current_gate: 'G4' });
      expect((await notices(intent)).slice(-3)).toEqual([
        ['spec_changed', 'G2', 'G4'],
        ['hotl_passed', 'G3', 'G2'],
        ['hotl_passed', 'G4', 'G3'],
      ]);
      const passes = (await f.scope.gateDecisions.listForIntent(intent.id, 'G2')).filter(
        (d) => d.decision === 'pass',
      );
      expect(passes.at(-1)?.input_sha256).toBe(sha256(edited));
    });

    it('a spec a person links while the intent waits at G3 takes it back to G2', async () => {
      const intent = await atG3();
      git.commit({ 'docs/specs/T07-v2.md': '# T07 v2\n' });
      await link(await reload(intent), 'docs/specs/T07-v2.md');
      expect(await step(intent)).toEqual({ outcome: 'moved' });
      expect(await reload(intent)).toMatchObject({ current_gate: 'G2' });
      expect((await notices(intent)).at(-1)).toEqual(['spec_changed', 'G2', 'G3']);
    });

    it('a spec that cannot be read at head: back to G2, one notice, and it waits there', async () => {
      const intent = await atG3();
      git.commit({ [SPEC_PATH]: null });
      await settle(intent);
      expect(await reload(intent)).toMatchObject({ status: 'in_gate', current_gate: 'G2' });
      expect(await settle(intent)).toMatchObject({
        outcome: 'waiting',
        reason: 'spec_unavailable',
      });
      expect(await settle(intent)).toMatchObject({
        outcome: 'waiting',
        reason: 'spec_unavailable',
      });
      const unavailable = (await notices(intent)).filter(([kind]) => kind === 'spec_unavailable');
      expect(unavailable).toEqual([['spec_unavailable', 'G2', 'G3']]);
      const audit = await f.scope.audit.listForEntity(intent.id, ['spec.unavailable']);
      expect(audit.map((row) => row.payload)).toEqual([
        {
          spec_ref_id: (await f.scope.specRefs.latest(intent.id))!.id,
          cause: 'missing',
          head_sha: git.head,
        },
      ]);

      // The file is back: G2 decides again (an approval from before the return no longer counts).
      git.commit({ [SPEC_PATH]: '# T07 Cancel an order\nAC1: stock returns.\n' });
      expect(await settle(intent)).toMatchObject({ outcome: 'waiting', reason: 'decision' });
      await decide(intent, 'G2', 'approve', 'a');
      await settle(intent);
      expect(await reload(intent)).toMatchObject({ current_gate: 'G3' });
    });

    it('the Git host cannot be read: the step waits and never passes', async () => {
      const intent = await atG3();
      await decide(intent, 'G3', 'approve', 'b');
      git.down = true;
      try {
        expect(await step(intent)).toEqual({
          outcome: 'waiting',
          reason: 'git_host_unavailable',
          wakeInMs: 60_000,
        });
        expect(await reload(intent)).toMatchObject({ current_gate: 'G3' });
      } finally {
        git.down = false;
      }
      await settle(intent);
      expect(await reload(intent)).toMatchObject({ current_gate: 'G4' });
    });

    it('a held gate still takes a rejection: Git host down at G3, spec unreadable at G2 (code review)', async () => {
      const g3 = await atG3();
      git.down = true;
      try {
        await decide(g3, 'G3', 'reject', 'b');
        await settle(g3);
        expect(await reload(g3)).toMatchObject({ status: 'rejected', current_gate: 'G3' });
      } finally {
        git.down = false;
      }

      const g2 = await atG2();
      git.commit({ 'docs/specs/T08.md': '# T08\n' });
      await link(await reload(g2), 'docs/specs/T08.md');
      git.commit({ 'docs/specs/T08.md': null });
      expect(await settle(g2)).toMatchObject({ outcome: 'waiting', reason: 'spec_unavailable' });
      // An approval does not move the held gate; a rejection ends the intent.
      await decide(g2, 'G2', 'approve', 'a');
      expect(await settle(g2)).toMatchObject({ outcome: 'waiting', reason: 'spec_unavailable' });
      expect(await reload(g2)).toMatchObject({ current_gate: 'G2' });
      await decide(g2, 'G2', 'reject', 'a');
      await settle(g2);
      expect(await reload(g2)).toMatchObject({ status: 'rejected' });
      git.commit({ 'docs/specs/T08.md': '# T08\n' });
    });

    it('a spec file that comes and goes is announced once per spec version and cause', async () => {
      const intent = await atG3();
      await decide(intent, 'G3', 'approve', 'b');
      git.commit({ [SPEC_PATH]: null });
      await settle(intent);
      expect(await reload(intent)).toMatchObject({ current_gate: 'G2' });
      git.commit({ [SPEC_PATH]: SPEC_TEXT });
      await decide(intent, 'G2', 'approve', 'a');
      await settle(intent);
      await decide(intent, 'G3', 'approve', 'b');
      git.commit({ [SPEC_PATH]: null });
      await settle(intent);
      expect(await reload(intent)).toMatchObject({ current_gate: 'G2' });
      const unavailable = (await notices(intent)).filter(([kind]) => kind === 'spec_unavailable');
      expect(unavailable).toHaveLength(1);
      git.commit({ [SPEC_PATH]: SPEC_TEXT });
    });

    it('G4 reads the head once: the spec checked is the run base (QUESTIONS #160)', async () => {
      const intent = await atG3();
      await decide(intent, 'G3', 'approve', 'b');
      await settle(intent);
      expect(await reload(intent)).toMatchObject({ current_gate: 'G4' });
      const g4Deps: StepDeps = {
        ...deps(),
        g4: {
          gitHost: {
            getBranchHead: () => git.getBranchHead(),
            getFileAtCommit: (ref, path, sha) => git.getFileAtCommit(ref, path, sha),
            listPaths: () => Promise.resolve([]),
          },
          allowedModels: () => Promise.resolve([]),
        },
      };
      const before = git.headReads;
      await stepIntent(f.scope, g4Deps, intent.id);
      expect(git.headReads - before).toBe(1);
    });
  });
});
