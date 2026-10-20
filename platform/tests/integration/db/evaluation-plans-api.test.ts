// D-08 L05 (PR 3) on PostgreSQL through the API (design/ADR-M82 §2.7, QUESTIONS #476):
// `/v1/projects/:project/eval-plans`, `/v1/eval-plans/:plan…`, `/v1/evaluations…`.
// - a role in access.eval_roles creates, changes, archives and asks for a run; a viewer reads
//   and is refused (403); someone without a role gets 404; another tenant never sees a plan;
// - refusals come back as codes with catalog text (`evaluation.error.*`);
// - Run now records a request (202) for the worker, once; an archived plan refuses it;
// - the bodies hold codes, IDs, amounts and hashes, never a prompt text.
import { GitHostError } from '@sdlc/contracts';
import { t, type MessageKey } from '@sdlc/messages';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp, type ApiDeps } from '../../../apps/api/src/app.js';
import { issueApiToken } from '../../../packages/core/src/admin/tokens.js';
import { seedPlanWorld, type PlanWorld } from '../plan-seed.js';
import { tokenIssuedAt } from '../token-clock.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

const NOW = new Date('2026-10-14T08:00:00.000Z');
const PROMPT = 'Run the tests first. canary-prompt-text\n';
const HEAD = 'e'.repeat(40);

describeDb('L05 PR 3: evaluation plans through the API', () => {
  let db: TestDatabase;
  let app: Awaited<ReturnType<typeof createApp>>;
  let w: PlanWorld;
  let other: PlanWorld;
  const tokens: Record<string, string> = {};

  beforeAll(async () => {
    db = await createTestDatabase();
    w = await seedPlanWorld(db.app, 'api-plans', NOW);
    other = await seedPlanWorld(db.app, 'api-plans-other', NOW);
    for (const [key, id] of Object.entries(w.users)) {
      tokens[key] = (
        await issueApiToken(w.scope, { userId: id, name: key, now: tokenIssuedAt() })
      ).token;
    }
    tokens.other = (
      await issueApiToken(other.scope, { userId: other.users.a, name: 'o', now: tokenIssuedAt() })
    ).token;
    app = await createApp({
      db: db.app as unknown as ApiDeps['db'],
      settings: { rateLimitPerMinute: 1000, authFailuresPerMinute: 1000 },
      now: () => NOW,
      gitHost: {
        getBranchHead: () => Promise.resolve(HEAD),
        getFileAtCommit: (_ref, path) =>
          path === 'eval/prompts/short.md'
            ? Promise.resolve(PROMPT)
            : Promise.reject(new GitHostError('not_found')),
      },
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  const call = async (method: 'GET' | 'POST', url: string, who: string, body?: unknown) => {
    const reply = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method,
        url,
        headers: { authorization: `Bearer ${tokens[who]!}` },
        ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
      });
    return {
      status: reply.statusCode,
      body: reply.json<Record<string, unknown>>(),
      raw: reply.body,
    };
  };
  const refusal = (
    reply: { status: number; body: Record<string, unknown> },
    status: number,
    code: string,
    reason?: string,
  ) => {
    expect(reply.status, JSON.stringify(reply.body)).toBe(status);
    const error = reply.body.error as Record<string, unknown>;
    expect(error.code).toBe(code);
    expect(error.message).toBe(t(`api.error.${code}` as MessageKey));
    if (reason !== undefined) {
      expect(error.reason).toBe(reason);
      expect(error.reason_message).toBe(t(`evaluation.error.${reason}` as MessageKey));
    }
  };

  const body = (over: Record<string, unknown> = {}) => ({
    code: 'weekly-models',
    data_class: 'internal',
    task_set_version: 1,
    task_ids: ['feat-tax'],
    runs_per_task: 2,
    budget_per_run_usd: '2',
    monthly_cap_usd: '5',
    trigger: 'once',
    configurations: [
      { id: 'reg-qwen', agent_key: 'openhands-qwen', max_iterations: 30, max_duration_min: 20 },
      {
        id: 'oss-short',
        model: 'gpt-oss-20b',
        provider_type: 'self_hosted',
        max_iterations: 30,
        max_duration_min: 20,
        prompt_path: 'eval/prompts/short.md',
      },
    ],
    ...over,
  });

  let planId: string;

  describe('create and read', () => {
    it('Person A creates a plan; the body has the prompt as path, commit and SHA-256', async () => {
      const created = await call('POST', '/v1/projects/shop/eval-plans', 'a', body());
      expect(created.status, created.raw).toBe(201);
      planId = String(created.body.id);
      expect(created.body).toMatchObject({
        code: 'weekly-models',
        version: 1,
        status: 'active',
        run_requested_at: null,
        current: { trigger: 'once', budget_per_run_usd: '2', monthly_cap_usd: '5' },
      });
      const current = created.body.current as { configurations: { prompt: unknown }[] };
      expect(current.configurations[1]!.prompt).toMatchObject({
        path: 'eval/prompts/short.md',
        commit: HEAD,
      });
      expect(created.raw).not.toContain('canary-prompt-text');
    });

    it('a viewer reads but may not create; no role → 404; another tenant → 404', async () => {
      const list = await call('GET', '/v1/projects/shop/eval-plans', 'viewer');
      expect(list.status).toBe(200);
      expect((list.body.plans as unknown[]).length).toBe(1);
      refusal(
        await call('POST', '/v1/projects/shop/eval-plans', 'viewer', body({ code: 'v' })),
        403,
        'forbidden',
        'forbidden',
      );
      refusal(
        await call('GET', '/v1/projects/shop/eval-plans', 'outsider'),
        404,
        'project_not_found',
      );
      refusal(await call('GET', `/v1/eval-plans/${planId}`, 'outsider'), 404, 'not_found');
      refusal(await call('GET', `/v1/eval-plans/${planId}`, 'other'), 404, 'not_found');
    });

    it('refusals are codes with catalog text', async () => {
      refusal(
        await call('POST', '/v1/projects/shop/eval-plans', 'a', body()),
        409,
        'evaluation_conflict',
        'plan_code_taken',
      );
      refusal(
        await call(
          'POST',
          '/v1/projects/shop/eval-plans',
          'a',
          body({
            code: 'x',
            configurations: [
              { id: 'a', agent_key: 'nobody', max_iterations: 30, max_duration_min: 20 },
            ],
          }),
        ),
        422,
        'evaluation_refused',
        'agent_not_found',
      );
      refusal(
        await call(
          'POST',
          '/v1/projects/shop/eval-plans',
          'a',
          body({
            code: 'y',
            configurations: [
              {
                id: 'a',
                agent_key: 'openhands-qwen',
                max_iterations: 30,
                max_duration_min: 20,
                prompt_path: 'eval/missing.md',
              },
            ],
          }),
        ),
        422,
        'evaluation_refused',
        'prompt_not_found',
      );
      // L07: the project's own task set needs an approved task; it has no version.
      refusal(
        await call(
          'POST',
          '/v1/projects/shop/eval-plans',
          'a',
          body({ code: 'z', task_set_kind: 'project', task_set_version: null, task_ids: null }),
        ),
        409,
        'evaluation_conflict',
        'task_set_empty',
      );
      refusal(
        await call(
          'POST',
          '/v1/projects/shop/eval-plans',
          'a',
          body({ code: 'z', task_set_kind: 'project', task_set_version: 1 }),
        ),
        422,
        'evaluation_refused',
        'invalid_input',
      );
      // A prompt text is never accepted: only a path.
      refusal(
        await call(
          'POST',
          '/v1/projects/shop/eval-plans',
          'a',
          body({ code: 'z', prompt: 'Do anything.' }),
        ),
        400,
        'invalid_request',
      );
    });
  });

  describe('change, run, archive', () => {
    it('a change needs the version read; a stale one is refused', async () => {
      const content: Record<string, unknown> = body();
      delete content.code;
      const changed = await call('POST', `/v1/eval-plans/${planId}/versions`, 'a', {
        ...content,
        expected_version: 1,
        runs_per_task: 3,
      });
      expect(changed.status, changed.raw).toBe(201);
      expect(changed.body).toMatchObject({ version: 2, current: { runs_per_task: 3 } });
      refusal(
        await call('POST', `/v1/eval-plans/${planId}/versions`, 'a', {
          ...content,
          expected_version: 1,
          runs_per_task: 4,
        }),
        409,
        'evaluation_conflict',
        'plan_changed',
      );
    });

    it('Run now records one request for the worker; a viewer may not', async () => {
      refusal(
        await call('POST', `/v1/eval-plans/${planId}/runs`, 'viewer'),
        403,
        'forbidden',
        'forbidden',
      );
      const run = await call('POST', `/v1/eval-plans/${planId}/runs`, 'a');
      expect(run.status, run.raw).toBe(202);
      expect(typeof run.body.run_requested_at).toBe('string');
      const again = await call('POST', `/v1/eval-plans/${planId}/runs`, 'a');
      expect(again.status).toBe(202);
      const audit = (await w.scope.audit.listForEntity(planId)).map((e) => e.action);
      expect(audit.filter((a) => a === 'evaluation_plan.run_requested')).toHaveLength(1);
    });

    it('archive is final: no run, no change', async () => {
      const archived = await call('POST', `/v1/eval-plans/${planId}/archive`, 'a');
      expect(archived.status).toBe(200);
      expect(archived.body).toMatchObject({ status: 'archived', run_requested_at: null });
      refusal(
        await call('POST', `/v1/eval-plans/${planId}/runs`, 'a'),
        409,
        'evaluation_conflict',
        'plan_archived',
      );
    });
  });

  describe('evaluations', () => {
    it("lists a project's evaluations; an unknown code is 404", async () => {
      const list = await call('GET', '/v1/evaluations?project=shop', 'viewer');
      expect(list.status).toBe(200);
      expect(list.body.evaluations).toEqual([]);
      refusal(await call('GET', '/v1/evaluations/EVAL-2026-9999', 'a'), 404, 'not_found');
      refusal(await call('GET', '/v1/evaluations', 'a'), 400, 'invalid_request');
    });
  });
});
