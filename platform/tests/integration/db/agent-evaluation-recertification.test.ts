// D-08 L10 AC1–AC4 on PostgreSQL (design/ADR-M86 §2.6; QUESTIONS #499, #506, #507):
// - `recertify` names an evaluation that qualifies for the agent's current version within
//   `recertification_max_age_days` (fresh and old evaluations);
// - aging: compared with the evaluation of the last activation on the shared tasks with the one
//   test of ADR-M83; a drop refuses in `required` mode and warns in `warn` mode; too few shared
//   tasks, or an activation without an evaluation, skip the comparison and say so;
// - the platform never suspends the agent; FR-36 is unchanged (an overdue agent still runs);
// - `agent.recertified` keeps the evaluation ID and the result code; `?overdue=true` shows the
//   latest evaluation of each overdue agent.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp, type ApiDeps } from '../../../apps/api/src/app.js';
import { issueApiToken } from '../../../packages/core/src/admin/tokens.js';
import { recertifyAgentAs } from '../../../packages/core/src/agents/approvals.js';
import { checkAgentForRun } from '../../../packages/core/src/agents/check.js';
import { agentRegisterErrorMessage } from '../../../packages/core/src/agents/errors.js';
import { TASKS, agentEvaluationHelpers, type World } from '../agent-evaluation-seed.js';
import { tokenIssuedAt } from '../token-clock.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

const DAY_MS = 86_400_000;

describeDb('L10: evaluations in the agent recertification on PostgreSQL', () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  });

  const { configure, evaluationYaml, world, agentOf, evaluate, approve, refusal } =
    agentEvaluationHelpers(() => t, 'agent-recert');

  /**
   * An agent activated in `warn` mode with `activation` (or no evaluation), then the project's
   * mode for the recertification.
   */
  async function activated(
    mode: string,
    activation: 'good' | 'partial' | 'none' = 'good',
  ): Promise<World> {
    const w = await world('    mode: warn\n');
    let code: string | undefined;
    if (activation !== 'none') {
      code = (await evaluate(w, {}, activation === 'partial' ? { taskIds: TASKS.slice(0, 2) } : {}))
        .code;
    }
    await approve(w, 'owner', code);
    await approve(w, 'person_b', code);
    expect((await agentOf(w)).status).toBe('active');
    await configure(w, w.projectId, evaluationYaml(mode));
    return w;
  }

  const recertify = (w: World, evaluationCode?: string, now: Date = new Date()) =>
    recertifyAgentAs(w.scope, { type: 'human', userId: w.users.a }, 'coder', {
      now,
      ...(evaluationCode === undefined ? {} : { evaluationCode }),
    });

  const recertifiedEvents = async (w: World) =>
    (await w.scope.audit.listForEntity((await agentOf(w)).id, ['agent.recertified'])).map(
      (event) => event.payload,
    );

  describe('a fresh evaluation without a drop', () => {
    it('recertifies, compares with the last activation, records the ID and the code', async () => {
      const w = await activated('    mode: required\n');
      const evaluation = await evaluate(w, { current: { resolved: (task) => task !== 't-h' } });
      const result = await recertify(w, evaluation.code);
      expect(result.evaluation).toMatchObject({
        result: 'passed',
        params: { rate: '0.875', tasks: '8' },
        aging: { status: 'compared', reason: null, params: { shared: '8', before_rate: '1.000' } },
      });
      expect(result.agent.last_recertified_at).not.toBeNull();
      expect((await recertifiedEvents(w)).at(-1)).toEqual({
        agent_key: 'coder',
        evaluation_id: evaluation.id,
        evaluation_result: 'passed',
      });
    });
  });

  describe('an old evaluation: recertification_max_age_days', () => {
    it('required refuses at 91 days; 90 days pass', async () => {
      const w = await activated('    mode: required\n');
      const evaluation = await evaluate(w, {});
      const finished = evaluation.finished_at!.getTime();
      const error = await refusal(recertify(w, evaluation.code, new Date(finished + 91 * DAY_MS)));
      expect(error.code).toBe('evaluation_too_old');
      expect(error.params).toMatchObject({ days: '91', max: '90' });
      const ok = await recertify(w, evaluation.code, new Date(finished + 90 * DAY_MS));
      expect(ok.evaluation.result).toBe('passed');
    });

    it('warn recertifies with the warning and records the code', async () => {
      const w = await activated('    mode: warn\n    recertification_max_age_days: 30\n');
      const evaluation = await evaluate(w, {});
      const result = await recertify(
        w,
        evaluation.code,
        new Date(evaluation.finished_at!.getTime() + 31 * DAY_MS),
      );
      expect(result.evaluation).toMatchObject({ mode: 'warn', result: 'evaluation_too_old' });
      expect(result.agent.last_recertified_at).not.toBeNull();
      expect((await recertifiedEvents(w)).at(-1)).toMatchObject({
        evaluation_result: 'evaluation_too_old',
      });
    });
  });

  describe('aging: a significant drop since the last activation', () => {
    const dropped = { current: { resolved: () => false } };

    it('required refuses with the numbers; the agent stays active', async () => {
      const w = await activated('    mode: required\n    min_resolve_rate: 0\n');
      const before = (await agentOf(w)).last_recertified_at;
      const evaluation = await evaluate(w, dropped);
      const error = await refusal(recertify(w, evaluation.code));
      expect(error.code).toBe('evaluation_quality_dropped');
      expect(error.params).toMatchObject({ rate: '0.000', before_rate: '1.000', shared: '8' });
      expect(Number(error.params.p_value)).toBeLessThan(0.05);
      const text = agentRegisterErrorMessage(error, 'coder');
      expect(text).toContain('0.000');
      expect(text).toContain('1.000');
      // The platform never suspends the agent by itself (§20.9); nothing was recertified.
      const agent = await agentOf(w);
      expect(agent.status).toBe('active');
      expect(agent.last_recertified_at).toBe(before);
    });

    it('warn recertifies with the warning; the agent stays active', async () => {
      const w = await activated('    mode: warn\n    min_resolve_rate: 0\n');
      const evaluation = await evaluate(w, dropped);
      const result = await recertify(w, evaluation.code);
      expect(result.evaluation).toMatchObject({
        result: 'evaluation_quality_dropped',
        params: { before: expect.stringMatching(/^EVAL-/) as unknown },
      });
      expect(result.agent.status).toBe('active');
      expect((await recertifiedEvents(w)).at(-1)).toMatchObject({
        evaluation_id: evaluation.id,
        evaluation_result: 'evaluation_quality_dropped',
      });
    });

    it('a lower rate that the test does not call different is no drop', async () => {
      const w = await activated('    mode: required\n');
      const evaluation = await evaluate(w, {
        current: { resolved: (task) => task !== 't-a' && task !== 't-b' },
      });
      const result = await recertify(w, evaluation.code);
      expect(result.evaluation).toMatchObject({
        result: 'passed',
        aging: { status: 'compared', params: { rate: '0.750', before_rate: '1.000' } },
      });
    });
  });

  describe('aging skipped, and the answer says so', () => {
    it('fewer shared tasks than min_tasks', async () => {
      const w = await activated('    mode: required\n', 'partial');
      const evaluation = await evaluate(w, {});
      const result = await recertify(w, evaluation.code);
      expect(result.evaluation).toMatchObject({
        result: 'passed',
        aging: {
          status: 'skipped',
          reason: 'too_few_shared_tasks',
          params: { shared: '2', min: '8' },
        },
      });
    });

    it('an activation that named no evaluation (QUESTIONS #506)', async () => {
      const w = await activated('    mode: required\n', 'none');
      const evaluation = await evaluate(w, {});
      const result = await recertify(w, evaluation.code);
      expect(result.evaluation).toMatchObject({
        result: 'passed',
        aging: { status: 'skipped', reason: 'no_activation_evaluation' },
      });
    });
  });

  describe('the modes', () => {
    it('required: no evaluation is refused; warn: recertified as missing; off: as before', async () => {
      const required = await activated('    mode: required\n');
      expect((await refusal(recertify(required))).code).toBe('evaluation_missing');

      const warn = await activated('    mode: warn\n');
      expect((await recertify(warn)).evaluation).toMatchObject({ result: 'missing' });
      expect((await recertifiedEvents(warn)).at(-1)).toEqual({
        agent_key: 'coder',
        evaluation_result: 'missing',
      });

      const off = await activated('    mode: off\n');
      expect((await recertify(off)).evaluation).toMatchObject({ mode: 'off', result: null });
      expect((await recertifiedEvents(off)).at(-1)).toEqual({ agent_key: 'coder' });
    });
  });

  it('FR-36 unchanged: an overdue agent still runs, with the warning', async () => {
    const w = await activated('    mode: required\n');
    const agent = await agentOf(w);
    const checked = await checkAgentForRun(w.scope, {
      agentId: agent.id,
      projectId: w.projectId,
      autonomyLevel: 'L2',
      allowedModels: ['qwen3-8b'],
      instructionsSha256: agent.instructions_sha256,
      // Four months after the activation (the first certification): overdue.
      now: new Date(Date.now() + 120 * DAY_MS),
    });
    expect(checked.warnings).toEqual(['recertification_overdue']);
  });

  describe('through the API (AC1, AC3)', () => {
    let app: Awaited<ReturnType<typeof createApp>>;
    afterAll(async () => {
      await app?.close();
    });

    it('recertify takes evaluation_code; ?overdue=true lists the latest evaluation', async () => {
      const w = await activated('    mode: warn\n');
      const evaluation = await evaluate(w, {});
      // 95 days later: the agent is overdue (3 months) and the evaluation too old (90 days).
      const later = Date.now() + 95 * DAY_MS;
      app = await createApp({
        db: t.app as unknown as ApiDeps['db'],
        settings: { rateLimitPerMinute: 1000, authFailuresPerMinute: 1000 },
        now: () => new Date(later),
      });
      const owner = (
        await issueApiToken(w.scope, {
          userId: w.users.a,
          name: 'x',
          now: tokenIssuedAt(),
          lifetimeDays: 365,
        })
      ).token;
      const inject = (method: 'GET' | 'POST', url: string, payload?: object) =>
        app
          .getHttpAdapter()
          .getInstance()
          .inject({
            method,
            url,
            headers: { authorization: `Bearer ${owner}` },
            ...(payload ? { payload: payload as Record<string, unknown> } : {}),
          });
      interface ApiBody {
        readonly items: readonly { readonly key: string; readonly evaluation?: unknown }[];
        readonly evaluation?: unknown;
        readonly error?: { readonly reason?: string };
      }
      const body = (reply: { json(): unknown }): ApiBody => reply.json() as ApiBody;

      const overdue = body(await inject('GET', '/v1/admin/agents?overdue=true'));
      // The seed's two other agents are overdue too; they have no evaluation.
      const coder = overdue.items.find((item) => item.key === 'coder');
      expect(overdue.items.find((item) => item.key === 'openhands-qwen')?.evaluation).toBeNull();
      expect(coder?.evaluation).toMatchObject({
        code: evaluation.code,
        result: 'evaluation_too_old',
        qualifies: false,
        params: { max: '90' },
      });
      expect(body(await inject('GET', '/v1/admin/agents')).items.length).toBeGreaterThan(1);
      expect((await inject('GET', '/v1/admin/agents?overdue=maybe')).statusCode).toBe(400);
      expect(
        (
          await inject('POST', '/v1/admin/agents/coder/recertify', {
            evaluation_code: 'EVAL-1',
          })
        ).statusCode,
      ).toBe(400);

      // warn: recertified, and the answer carries the result as a warning.
      const done = await inject('POST', '/v1/admin/agents/coder/recertify', {
        evaluation_code: evaluation.code,
      });
      expect(done.statusCode, done.body).toBe(200);
      expect(body(done).evaluation).toMatchObject({
        mode: 'warn',
        result: 'evaluation_too_old',
        qualifies: false,
      });
      const after = body(await inject('GET', '/v1/admin/agents?overdue=true')).items;
      expect(after.map((item) => item.key)).not.toContain('coder');
    });
  });
});
