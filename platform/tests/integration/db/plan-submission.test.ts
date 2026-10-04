// D-08 B09 on a live PostgreSQL (design/ADR-M40, QUESTIONS #165–#168):
// - AC1: the plan is the file `.sdlc/plans/<intent code>.yaml` in the repository (path patterns,
//   tools, change flags; free text stays in the repository).
// - AC2: a person submits it through the API; the platform reads it at the head of the default
//   branch, hashes it and stores `plans` (coded fields only); who may submit comes from
//   `access.plan_submit_roles`; Person B approves G3 and the submitter never does (FR-11); the
//   flags drive forced HITL at G3 (FR-15).
// - AC3: a plan changed after approval needs G3 again: when the file at head is not the submitted
//   plan, G3 or G4 is held until a person submits it again (QUESTIONS #167); a new plan submitted
//   at G4 takes the intent back to G3 with the approvals voided (FR-17).
// The Git host is an in-memory fake; `platform/tests/plans/plan-rules.test.ts` covers the file
// rules.
import { loadProjectConfig } from '@sdlc/config';
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
import { planFileSha256, planPath } from '../../../packages/core/src/plans/rules.js';
import { submitPlanFromGitHost } from '../../../packages/core/src/plans/submit.js';
import { RegistryError } from '../../../packages/core/src/registry/errors.js';
import { linkSpecFromGitHost } from '../../../packages/core/src/specs/link.js';
import { stepIntent, type StepDeps } from '../../../packages/core/src/workflow/step.js';
import { FakeSpecGitHost as FakeGitHost, SPEC_PATH } from '../fake-spec-git-host.js';
import { createWorkflowFixture, type Person, type WorkflowFixture } from '../workflow/fixture.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

const NOW = new Date('2026-09-28T01:00:00.000Z');
const SUMMARY = 'Cancel an order and return the stock';

interface PlanOptions {
  readonly paths?: readonly string[];
  readonly tools?: readonly string[];
  readonly flags?: readonly string[];
  /** More lines of the `plan` block. */
  readonly planExtra?: string;
  /** More lines after the first task (at task level). */
  readonly extra?: string;
}

/** A plan file of schema version 1 (template T13). */
function planYaml(code: string, options: PlanOptions = {}): string {
  const paths = options.paths ?? ['apps/api/src/orders/**', 'apps/api/test/orders/**'];
  return [
    'plan:',
    `  intent_id: ${code}`,
    `  change_flags: [${(options.flags ?? []).join(', ')}]`,
    ...(options.planExtra ? [options.planExtra] : []),
    'tasks:',
    '  - id: T1',
    `    summary: ${SUMMARY}`,
    '    allowed_paths:',
    ...paths.map((p) => `      - ${JSON.stringify(p)}`),
    `    tools: [${(options.tools ?? ['file_editor', 'terminal']).join(', ')}]`,
    ...(options.extra ? [options.extra] : []),
    '',
  ].join('\n');
}

interface Reply {
  readonly statusCode: number;
  json(): Record<string, unknown> & {
    readonly error?: {
      readonly code: string;
      readonly message: string;
      readonly reason?: string;
      readonly details?: readonly { readonly path: string; readonly issue: string }[];
    };
  };
}

describeDb('B09: plan submission and the plan re-check on PostgreSQL', () => {
  let db: TestDatabase;
  let f: WorkflowFixture;
  let git: FakeGitHost;
  let app: Awaited<ReturnType<typeof createApp>>;
  let configVersion = 0;
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
  const decide = async (intent: Intent, gate: string, decision: CommandDecision, who: Person) =>
    decideGate(f.registry, f.scope, {
      intent: await reload(intent),
      gate,
      decision,
      actorId: f.users[who],
      reasonCode: decision === 'approve' ? null : 'spec_unclear',
      source: 'cli',
    });
  const submit = async (intent: Intent, who: Person = 'a') =>
    submitPlanFromGitHost(
      f.scope,
      { gitHost: git },
      { intent: await reload(intent), actorId: f.users[who] },
    );
  const writePlan = (intent: Intent, options?: PlanOptions) =>
    git.commit({ [planPath(intent.code)]: planYaml(intent.code, options) });
  const notices = async (intent: Intent) =>
    (await f.scope.intentNotices.listForIntent(intent.id)).map((n) => [n.kind, n.gate]);
  const resubmitEvents = async (intent: Intent) =>
    (await f.scope.audit.listForEntity(intent.id, ['plan.resubmit_needed'])).map(
      (e) => (e.payload as { cause: string }).cause,
    );
  const setConfig = async (yaml: string) => {
    const loaded = loadProjectConfig(yaml);
    if (!loaded.ok) throw new Error('test configuration refused');
    await f.scope.projectConfigs.save(f.target.projectId, {
      configYaml: yaml,
      configHash: loaded.configHash,
      updatedBy: null,
      expectedVersion: configVersion,
    });
    configVersion += 1;
  };

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

  /** An intent at G2 with its spec linked (G1 approved by Person A). */
  async function atG2(riskTier: 'low' | 'medium' = 'medium'): Promise<Intent> {
    const intent = await f.newIntent({ riskTier });
    await settle(intent);
    await decide(intent, 'G1', 'approve', 'a');
    await settle(intent);
    await linkSpecFromGitHost(
      f.scope,
      { gitHost: git },
      { intent: await reload(intent), path: SPEC_PATH, actorId: f.users.a },
    );
    expect(await reload(intent)).toMatchObject({ current_gate: 'G2' });
    return intent;
  }

  /** A Medium intent at G3 with a submitted plan file (G2 approved by Person A). */
  async function atG3(options?: PlanOptions): Promise<Intent> {
    const intent = await atG2();
    await decide(intent, 'G2', 'approve', 'a');
    writePlan(intent, options);
    await submit(intent);
    expect(await settle(intent)).toMatchObject({ outcome: 'waiting', reason: 'decision' });
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

  describe('AC1, AC2: submitting the plan file (API, QUESTIONS #165, #168)', () => {
    it('reads the file at the head of the default branch and stores its hash and coded fields', async () => {
      git.down = false;
      const intent = await atG2();
      const text = planYaml(intent.code, {
        paths: ['apps/web/src/orders/**', 'apps/api/src/orders/**', 'apps/api/src/orders/**'],
        flags: ['migration'],
        extra: '  - id: T2\n    allowed_paths: [apps/api/test/**]\n    tools: [task_tracker]',
      });
      const head = git.commit({ [planPath(intent.code)]: text });
      const reply = await inject('POST', `/v1/intents/${intent.code}/plans`, tokens.a);
      expect(reply.statusCode, JSON.stringify(reply.json())).toBe(201);
      expect(reply.json()).toMatchObject({
        intent: intent.code,
        version: 1,
        commit_sha: head,
        plan_sha256: planFileSha256(text),
        planned_files: ['apps/api/src/orders/**', 'apps/api/test/**', 'apps/web/src/orders/**'],
        allowed_tools: ['file_editor', 'task_tracker', 'terminal'],
        change_flags: ['migration'],
      });
      // Coded fields only: the summary stays in the repository.
      const dump = JSON.stringify(
        (await sql`SELECT * FROM plans WHERE intent_id = ${intent.id}`.execute(db.owner)).rows,
      );
      expect(dump).not.toContain(SUMMARY);
      const stored = (await f.scope.plans.latest(intent.id))!;
      expect(stored).toMatchObject({ summary: '', submitted_by: f.users.a });
      const audit = await f.scope.audit.listForEntity(intent.id, ['plan.submitted']);
      expect(audit.at(-1)?.payload).toEqual({
        plan_id: stored.id,
        version: 1,
        plan_sha256: planFileSha256(text),
        commit_sha: head,
      });

      // The same file again: no new version.
      const again = await inject('POST', `/v1/intents/${intent.code}/plans`, tokens.a, {});
      expect(again.json()).toMatchObject({ version: 1 });
      const list = await inject('GET', `/v1/intents/${intent.code}/plans`, tokens.b);
      expect(list.statusCode).toBe(200);
      expect(list.json()).toMatchObject({ intent: intent.code, items: [{ version: 1 }] });
    });

    it('who may submit: plan_submit_roles (Person A); a read role → 403; no role → 404', async () => {
      const intent = await atG2();
      writePlan(intent);
      const url = `/v1/intents/${intent.code}/plans`;
      for (const who of ['b', 'pm', 'viewer'] as const) {
        expectError(await inject('POST', url, tokens[who]), 403, 'forbidden');
      }
      expectError(await inject('POST', url, tokens.outsider), 404, 'intent_not_found');
      expectError(await inject('GET', url, tokens.outsider), 404, 'intent_not_found');
      expect((await inject('POST', url, tokens.a)).statusCode).toBe(201);
    });

    it('a commit must hold the same file as the head (409 otherwise); the head is stored (#212)', async () => {
      const intent = await atG2();
      const old = writePlan(intent, { paths: ['apps/api/src/**'] });
      const same = writePlan(intent);
      const head = git.commit({ 'README.md': '# shop\n' }); // the head moves, the plan file stays
      const url = `/v1/intents/${intent.code}/plans`;
      expectError(
        await inject('POST', url, tokens.a, { commit_sha: old }),
        409,
        'plan_not_on_default_branch',
      );
      // QUESTIONS #212: an older commit with the same content is accepted, but the stored commit
      // is the head the platform read, so the runner always finds it in its clone.
      const reply = await inject('POST', url, tokens.a, { commit_sha: same });
      expect(reply.statusCode).toBe(201);
      expect(same).not.toBe(head);
      expect(reply.json()).toMatchObject({ commit_sha: head });
      expect((await f.scope.plans.latest(intent.id))?.commit_sha).toBe(head);
    });

    it('a refused file → 422 plan_invalid with the reason; nothing is stored', async () => {
      const intent = await atG2();
      const url = `/v1/intents/${intent.code}/plans`;
      expectError(await inject('POST', url, tokens.a), 422, 'plan_invalid', 'missing');
      const cases: [PlanOptions | string, string][] = [
        ['plan: [\n', 'yaml_invalid'],
        [{ planExtra: '  approved_by: bob' }, 'platform_field'],
        [{ extra: '    limits: { budget_usd: 5 }' }, 'platform_field'],
        [{ tools: ['file_editor', 'browser'] }, 'unknown_tool'],
        [{ paths: ['**'] }, 'pattern_too_broad'],
        [{ paths: ['*/**'] }, 'pattern_too_broad'],
        [{ paths: ['.github/workflows/**'] }, 'protected_path'],
        [{ paths: ['apps/api/AGENTS.md'] }, 'protected_path'],
        [{ paths: ['../secrets/**'] }, 'invalid_pattern'],
      ];
      for (const [content, reason] of cases) {
        const text = typeof content === 'string' ? content : planYaml(intent.code, content);
        git.commit({ [planPath(intent.code)]: text });
        expectError(await inject('POST', url, tokens.a), 422, 'plan_invalid', reason);
      }
      git.commit({ [planPath(intent.code)]: planYaml('INT-2000-0001') });
      expectError(await inject('POST', url, tokens.a), 422, 'plan_invalid', 'intent_mismatch');
      // QUESTIONS #210: an agent-facing text field that is not text names the field (a key path).
      git.commit({
        [planPath(intent.code)]: planYaml(intent.code, { extra: '    input: { a: b }' }),
      });
      const notText = await inject('POST', url, tokens.a);
      expectError(notText, 422, 'plan_invalid', 'schema_invalid');
      expect(notText.json().error).toMatchObject({
        details: [{ path: 'file.tasks[0].input', issue: 'not_text' }],
      });
      expect(await f.scope.plans.list(intent.id)).toEqual([]);
    });

    it('the Git host down → 503; an intent past G4 or finished does not take a plan (409)', async () => {
      const intent = await atG2();
      writePlan(intent);
      git.down = true;
      expectError(
        await inject('POST', `/v1/intents/${intent.code}/plans`, tokens.a),
        503,
        'git_host_unavailable',
      );
      git.down = false;
      await decide(intent, 'G2', 'reject', 'a');
      await settle(intent);
      expect(await reload(intent)).toMatchObject({ status: 'rejected' });
      expectError(
        await inject('POST', `/v1/intents/${intent.code}/plans`, tokens.a),
        409,
        'plan_submit_not_allowed',
      );
    });

    it('Person B approves G3; the submitter never approves the plan (FR-11)', async () => {
      const intent = await atG3();
      await expect(decide(intent, 'G3', 'approve', 'a')).rejects.toBeInstanceOf(RegistryError);
      await decide(intent, 'G3', 'approve', 'b');
      await settle(intent);
      expect(await reload(intent)).toMatchObject({ current_gate: 'G4' });

      // A project where Person B may also submit: the one who submitted never approves G3.
      await setConfig('access:\n  plan_submit_roles: [person_a, person_b]\n');
      try {
        const other = await atG2();
        await decide(other, 'G2', 'approve', 'a');
        writePlan(other);
        await submit(other, 'b');
        await settle(other);
        const refused = await decide(other, 'G3', 'approve', 'b').catch((e: unknown) => e);
        expect(refused).toBeInstanceOf(RegistryError);
        expect((refused as RegistryError).reason).toBe('producer');
      } finally {
        await setConfig('{}\n');
      }
    });

    it('the plan flags drive G3 oversight: Low HOTL passes, `migration` forces HITL (FR-15)', async () => {
      const low = await atG2('low');
      await settle(low); // G2 HOTL passes with the spec
      expect(await reload(low)).toMatchObject({ current_gate: 'G3' });
      writePlan(low);
      await submit(low);
      await settle(low);
      expect(await reload(low)).toMatchObject({ current_gate: 'G4' });

      const flagged = await atG2('low');
      await settle(flagged);
      writePlan(flagged, { flags: ['migration'] });
      await submit(flagged);
      expect(await settle(flagged)).toMatchObject({ outcome: 'waiting', reason: 'decision' });
      expect(await reload(flagged)).toMatchObject({ current_gate: 'G3' });
    });
  });

  describe('AC3: a plan changed after approval needs G3 again (QUESTIONS #167)', () => {
    it('the file at head changed at G3 → held until submitted again; the old approval is void', async () => {
      const intent = await atG3();
      await decide(intent, 'G3', 'approve', 'b');
      writePlan(intent, { paths: ['apps/api/src/**'] });
      // Held: the gate's deadline still runs (wakeInMs).
      const held = { outcome: 'waiting', reason: 'plan_resubmit_needed' };
      expect(await settle(intent)).toMatchObject(held);
      expect(await settle(intent)).toMatchObject(held);
      expect(await reload(intent)).toMatchObject({ current_gate: 'G3' });
      expect(await resubmitEvents(intent)).toEqual(['changed']);
      expect((await notices(intent)).filter(([k]) => k === 'plan_resubmit_needed')).toEqual([
        ['plan_resubmit_needed', 'G3'],
      ]);
      // No automatic new version: the platform waits for a person.
      expect(await f.scope.plans.list(intent.id)).toHaveLength(1);

      await submit(intent);
      expect(await settle(intent)).toMatchObject({ outcome: 'waiting', reason: 'decision' });
      const voids = (await f.scope.gateDecisions.listForIntent(intent.id, 'G3')).filter(
        (d) => d.decision === 'void',
      );
      expect(voids).toHaveLength(1);
      await decide(intent, 'G3', 'approve', 'b');
      await settle(intent);
      expect(await reload(intent)).toMatchObject({ current_gate: 'G4' });
    });

    it('a removed file holds G3 (cause missing); a rejection is still handled', async () => {
      const intent = await atG3();
      git.commit({ [planPath(intent.code)]: null });
      expect(await settle(intent)).toMatchObject({
        outcome: 'waiting',
        reason: 'plan_resubmit_needed',
      });
      expect(await resubmitEvents(intent)).toEqual(['missing']);
      await decide(intent, 'G3', 'reject', 'b');
      await settle(intent);
      expect(await reload(intent)).toMatchObject({ status: 'rejected', current_gate: 'G3' });
    });

    it('the Git host down at G3 → held, never passes', async () => {
      const intent = await atG3();
      await decide(intent, 'G3', 'approve', 'b');
      git.down = true;
      try {
        expect(await settle(intent)).toMatchObject({
          outcome: 'waiting',
          reason: 'git_host_unavailable',
        });
        expect(await reload(intent)).toMatchObject({ current_gate: 'G3' });
      } finally {
        git.down = false;
      }
    });

    it('at G4: a changed file holds the run; a new plan takes the intent back to G3', async () => {
      const intent = await atG3();
      await decide(intent, 'G3', 'approve', 'b');
      await settle(intent);
      expect(await reload(intent)).toMatchObject({ current_gate: 'G4' });

      writePlan(intent, { paths: ['apps/api/src/**'] });
      expect(await settle(intent)).toEqual({ outcome: 'waiting', reason: 'plan_resubmit_needed' });
      expect(await reload(intent)).toMatchObject({ current_gate: 'G4' });

      await submit(intent);
      expect(await settle(intent)).toMatchObject({ outcome: 'waiting', reason: 'decision' });
      expect(await reload(intent)).toMatchObject({ status: 'in_gate', current_gate: 'G3' });
      expect(await notices(intent)).toContainEqual(['plan_changed', 'G3']);
      const g3 = await f.scope.gateDecisions.listForIntent(intent.id, 'G3');
      expect(g3.map((d) => d.decision)).toEqual(['approve', 'void']);
      expect(g3[1]).toMatchObject({ reason_code: 'input_mismatch', voids_decision_id: g3[0]!.id });
    });
  });
});
