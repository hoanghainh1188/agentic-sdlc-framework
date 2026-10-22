// D-08 L09 AC3–AC5 on PostgreSQL (design/ADR-M86 §2.3–§2.5, §2.7–§2.8; QUESTIONS #496–#504):
// - an `activate` approval names an evaluation; each condition of §2.3 passes or fails with its
//   code and the numbers its catalog text quotes;
// - `warn` accepts with the result as a warning, `required` refuses, `off` checks nothing;
// - the mode is the strictest of the agent's projects (`run.agent_key`), the thresholds come from
//   the evaluation's project;
// - a change is not worse than the last approved version in the same evaluation;
// - every approval of a round names the same evaluation;
// - the approval and its audit event keep the evaluation ID and the result code only;
// - another tenant's evaluation is not found; `latestAgentEvaluation` (`show`).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp, type ApiDeps } from '../../../apps/api/src/app.js';
import { issueApiToken } from '../../../packages/core/src/admin/tokens.js';
import { agentRegisterErrorMessage } from '../../../packages/core/src/agents/errors.js';
import {
  checkAgentEvaluation,
  latestAgentEvaluation,
} from '../../../packages/core/src/agents/evaluation-check.js';
import { changeAgentStatus, updateAgent } from '../../../packages/core/src/agents/register.js';
import type { PlanConfigurationInput } from '../../../packages/core/src/evaluation/index.js';
import {
  agentEvaluationHelpers,
  BY_KEY,
  NEW_SHA,
  NEXT,
  TASKS,
  type Scores,
  type World,
} from '../agent-evaluation-seed.js';
import { tokenIssuedAt } from '../token-clock.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

describeDb('L09 AC3–AC5: evaluations in the agent approvals on PostgreSQL', () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  });

  const { configure, evaluationYaml, world, agentOf, evaluate, approve, refusal } =
    agentEvaluationHelpers(() => t, 'agent-evals');

  /** The check of an evaluation for the agent as it is now, without recording an approval. */
  async function check(
    w: World,
    code: string,
    options: { now?: Date; change?: boolean } = {},
  ): Promise<unknown> {
    const agent = await agentOf(w);
    const verdict = await checkAgentEvaluation(w.scope, {
      agent,
      evaluationCode: code,
      purpose: 'approval',
      change: options.change ?? agent.status !== 'proposed',
      now: options.now ?? new Date(),
    });
    return { result: verdict.result, params: verdict.params };
  }

  describe('the mode', () => {
    it('warn (default): no evaluation is accepted as `missing`, kept in the audit', async () => {
      const w = await world();
      const first = await approve(w, 'owner');
      expect(first.evaluation).toMatchObject({ mode: 'warn', result: 'missing', evaluation: null });
      expect(first.approvals[0]).toMatchObject({
        evaluation_id: null,
        evaluation_result: 'missing',
      });
      const done = await approve(w, 'person_b');
      expect(done.completed).toBe(true);
      expect(done.agent.status).toBe('active');
      const events = await w.scope.audit.listForEntity(done.agent.id, ['agent.approval_recorded']);
      expect(events.map((e) => e.payload)).toEqual([
        expect.objectContaining({ evaluation_result: 'missing' }),
        expect.objectContaining({ evaluation_result: 'missing' }),
      ]);
      expect(events[0]!.payload).not.toHaveProperty('evaluation_id');
    });

    it('required: no evaluation is refused with evaluation_missing and its text', async () => {
      const w = await world('    mode: required\n');
      const error = await refusal(approve(w, 'owner'));
      expect(error.code).toBe('evaluation_missing');
      expect(agentRegisterErrorMessage(error, 'coder')).toContain('--evaluation');
      expect(await w.scope.agentApprovals.listForAgent((await agentOf(w)).id, 'activate')).toEqual(
        [],
      );
    });

    it('off: nothing is checked or recorded', async () => {
      const w = await world('    mode: off\n');
      const result = await approve(w, 'owner', 'EVAL-2026-9999');
      expect(result.evaluation).toMatchObject({ mode: 'off', result: null });
      expect(result.approvals[0]).toMatchObject({ evaluation_id: null, evaluation_result: null });
    });

    it('the strictest mode of the agent’s projects applies', async () => {
      const w = await world('    mode: warn\n');
      await configure(w, w.otherProjectId, evaluationYaml('    mode: required\n'));
      expect((await refusal(approve(w, 'owner'))).code).toBe('evaluation_missing');
    });
  });

  describe('a first use: the conditions of §2.3', () => {
    it('passes: both approvers name the evaluation, the agent becomes active', async () => {
      const w = await world('    mode: required\n');
      const evaluation = await evaluate(w, { current: { resolved: (task) => task !== 't-h' } });
      const first = await approve(w, 'owner', evaluation.code);
      expect(first.evaluation).toMatchObject({
        result: 'passed',
        params: { code: evaluation.code, rate: '0.875', tasks: '8' },
      });
      expect(first.approvals[0]).toMatchObject({
        evaluation_id: evaluation.id,
        evaluation_result: 'passed',
      });
      const done = await approve(w, 'person_b', evaluation.code);
      expect(done.agent.status).toBe('active');
      const [event] = await w.scope.audit.listForEntity(done.agent.id, ['agent.approval_recorded']);
      expect(event!.payload).toEqual({
        agent_key: 'coder',
        version: '1.0.0',
        purpose: 'activate',
        capacity: 'owner',
        evaluation_id: evaluation.id,
        evaluation_result: 'passed',
      });
    });

    it('evaluation_not_found: an unknown code, and another tenant’s evaluation', async () => {
      const w = await world();
      const other = await world();
      const theirs = await evaluate(other, {});
      expect(await check(w, 'EVAL-2026-9999')).toMatchObject({
        result: 'evaluation_not_found',
      });
      const w2 = await world();
      expect(await check(w2, theirs.code)).toMatchObject({ result: 'evaluation_not_found' });
    });

    it('evaluation_not_completed', async () => {
      const w = await world();
      const open = await evaluate(w, {}, { finish: false });
      expect(await check(w, open.code)).toMatchObject({ result: 'evaluation_not_completed' });
    });

    it('evaluation_other_project: an evaluation of a project that does not run the agent', async () => {
      const w = await world();
      // The agent now runs in `other` only; the evaluation is of `shop`.
      await configure(w, w.otherProjectId, evaluationYaml(''));
      await configure(w, w.projectId, 'run:\n  agent_key: openhands-qwen\n');
      const evaluation = await evaluate(w, {}, { configurations: [BY_KEY] });
      expect(await check(w, evaluation.code)).toMatchObject({
        result: 'evaluation_other_project',
      });
    });

    it('evaluation_not_matching: no configuration with the fingerprint', async () => {
      const w = await world();
      const other: PlanConfigurationInput = { ...BY_KEY, id: 'qwen', agentKey: 'openhands-qwen' };
      const evaluation = await evaluate(w, {}, { configurations: [other] });
      expect(await check(w, evaluation.code)).toMatchObject({
        result: 'evaluation_not_matching',
      });
      // Other instructions in one run: not the version's fingerprint either.
      const mixed = await evaluate(w, {
        current: { instructions: NEW_SHA },
      });
      expect(await check(w, mixed.code)).toMatchObject({
        result: 'evaluation_not_matching',
      });
    });

    // X03 (QUESTIONS #526): the adapter is part of the fingerprint (ADR-M86 §2.1).
    it('evaluation_not_matching: an evaluation of the same agent with another adapter', async () => {
      const w = await world();
      const evaluation = await evaluate(w, {});
      expect(await check(w, evaluation.code)).toMatchObject({ result: 'passed' });
      const configs = await w.scope.evaluations.configurations(evaluation.id);
      expect(configs.map((c) => c.adapter)).toEqual(configs.map(() => 'openhands'));
      await updateAgent(w.scope, 'coder', { version: '1.1.0', adapter: 'opencode' });
      expect(await check(w, evaluation.code)).toMatchObject({
        result: 'evaluation_not_matching',
      });
    });

    it('evaluation_task_set_partial: a plan that named task IDs', async () => {
      const w = await world();
      const evaluation = await evaluate(w, {}, { taskIds: TASKS.slice(0, 7) });
      expect(await check(w, evaluation.code)).toMatchObject({
        result: 'evaluation_task_set_partial',
      });
    });

    it('evaluation_too_few_tasks, with the numbers', async () => {
      const w = await world('    mode: warn\n    min_tasks: 9\n');
      const evaluation = await evaluate(w, {});
      expect(await check(w, evaluation.code)).toMatchObject({
        result: 'evaluation_too_few_tasks',
        params: { tasks: '8', min: '9' },
      });
    });

    it('evaluation_below_threshold: the rate and its interval in the catalog text', async () => {
      const w = await world('    mode: required\n');
      const evaluation = await evaluate(w, {
        current: { resolved: (task) => ['t-a', 't-b', 't-c'].includes(task) },
      });
      const error = await refusal(approve(w, 'owner', evaluation.code));
      expect(error.code).toBe('evaluation_below_threshold');
      expect(error.params).toMatchObject({ rate: '0.375', min: '0.500' });
      const text = agentRegisterErrorMessage(error, 'coder');
      expect(text).toContain('0.375');
      expect(text).toContain(`${error.params.low}–${error.params.high}`);
    });

    it('evaluation_scope_breach (fixed in code, even with a low threshold)', async () => {
      const w = await world('    mode: warn\n    min_resolve_rate: 0\n');
      const evaluation = await evaluate(w, { current: { breach: (task) => task === 't-a' } });
      expect(await check(w, evaluation.code)).toMatchObject({
        result: 'evaluation_scope_breach',
        params: { breaches: '1' },
      });
    });

    it('evaluation_too_old: approval_max_age_days from the evaluation’s project', async () => {
      const w = await world('    mode: warn\n    approval_max_age_days: 7\n');
      const evaluation = await evaluate(w, {});
      const later = new Date(evaluation.finished_at!.getTime() + 8 * 86_400_000);
      expect(await check(w, evaluation.code, { now: later })).toMatchObject({
        result: 'evaluation_too_old',
        params: { days: '8', max: '7' },
      });
    });

    it('evaluation_not_latest: a later evaluation of the same fingerprint counts', async () => {
      const w = await world();
      const first = await evaluate(w, {});
      const second = await evaluate(w, { current: { resolved: (task) => task < 't-e' } });
      expect(await check(w, first.code)).toMatchObject({
        result: 'evaluation_not_latest',
        params: { latest: second.code },
      });
    });
  });

  describe('one evaluation per round', () => {
    it('a different evaluation is refused, in warn mode too', async () => {
      const w = await world();
      const a = await evaluate(w, {});
      await approve(w, 'owner', a.code);
      const b = await evaluate(w, {});
      const error = await refusal(approve(w, 'person_b', b.code));
      expect(error.code).toBe('evaluation_round_mismatch');
      expect(agentRegisterErrorMessage(error, 'coder')).toContain(a.code);
    });

    it('none, then one, is a mismatch too', async () => {
      const w = await world();
      await approve(w, 'owner');
      const a = await evaluate(w, {});
      expect((await refusal(approve(w, 'person_b', a.code))).code).toBe(
        'evaluation_round_mismatch',
      );
    });
  });

  describe('a change (suspended → active): not worse than the last approved version', () => {
    /** Activates version 1.0.0, then evaluates `current` and `next`, then makes `next` the version. */
    async function changed(
      evaluation: string,
      scores: Readonly<Record<string, Scores>>,
      configurations: readonly PlanConfigurationInput[] = [BY_KEY, NEXT],
    ): Promise<{ w: World; code: string }> {
      // Version 1.0.0 was activated before the project required evaluations.
      const w = await world('    mode: warn\n');
      await approve(w, 'owner');
      await approve(w, 'person_b');
      await configure(w, w.projectId, evaluationYaml(evaluation));
      const { code } = await evaluate(w, scores, { configurations });
      await changeAgentStatus(w.scope, 'coder', { to: 'suspended', reason: 'quality' });
      await updateAgent(w.scope, 'coder', {
        version: '1.1.0',
        modelRef: 'gpt-oss-20b',
        instructionsSha256: NEW_SHA,
      });
      return { w, code };
    }

    it('passes when not worse; the baseline is the version of the last activation', async () => {
      const { w, code } = await changed('    mode: warn\n', {
        current: { resolved: (task) => task !== 't-a' },
        next: { instructions: NEW_SHA },
      });
      expect(await check(w, code)).toMatchObject({ result: 'passed' });
    });

    it('evaluation_worse_than_baseline: McNemar and the intervals both say worse', async () => {
      const { w, code } = await changed('    mode: required\n    min_resolve_rate: 0\n', {
        current: {},
        next: { instructions: NEW_SHA, resolved: () => false },
      });
      const error = await refusal(approve(w, 'owner', code));
      expect(error.code).toBe('evaluation_worse_than_baseline');
      expect(error.params).toMatchObject({
        rate: '0.000',
        baseline_rate: '1.000',
        paired: '8',
        version: '1.0.0',
      });
      expect(Number(error.params.p_value)).toBeLessThan(0.05);
    });

    it('a lower rate that the test does not call different passes', async () => {
      const { w, code } = await changed('    mode: warn\n', {
        current: {},
        next: { instructions: NEW_SHA, resolved: (task) => task !== 't-a' && task !== 't-b' },
      });
      expect(await check(w, code)).toMatchObject({ result: 'passed' });
    });

    it('evaluation_no_baseline: the plan did not run the approved version', async () => {
      const { w, code } = await changed('    mode: warn\n', { next: { instructions: NEW_SHA } }, [
        NEXT,
      ]);
      expect(await check(w, code)).toMatchObject({
        result: 'evaluation_no_baseline',
        params: { version: '1.0.0' },
      });
    });
  });

  it('show: the latest evaluation of the current fingerprint and its check', async () => {
    const w = await world();
    expect(await latestAgentEvaluation(w.scope, await agentOf(w), new Date())).toBeNull();
    await evaluate(w, {});
    const latest = await evaluate(w, { current: { resolved: (task) => task < 't-c' } });
    const verdict = await latestAgentEvaluation(w.scope, await agentOf(w), new Date());
    expect(verdict).toMatchObject({
      mode: 'warn',
      evaluation: { code: latest.code },
      result: 'evaluation_below_threshold',
      params: { rate: '0.250' },
    });
  });

  describe('through the API (AC3, AC4)', () => {
    let app: Awaited<ReturnType<typeof createApp>>;
    interface ApiBody {
      readonly error: {
        readonly code: string;
        readonly reason?: string;
        readonly reason_message?: string;
      };
      readonly evaluation: unknown;
      readonly approvals: readonly unknown[];
    }
    const body = (reply: { json(): unknown }): ApiBody => reply.json() as ApiBody;
    afterAll(async () => {
      await app?.close();
    });

    it('POST …/approvals takes evaluation_code; GET …/:key shows the latest evaluation', async () => {
      const w = await world('    mode: required\n');
      app = await createApp({
        db: t.app as unknown as ApiDeps['db'],
        settings: { rateLimitPerMinute: 1000, authFailuresPerMinute: 1000 },
        now: () => new Date(),
      });
      const token = async (userId: string) =>
        (await issueApiToken(w.scope, { userId, name: 'x', now: tokenIssuedAt() })).token;
      const owner = await token(w.users.a);
      const inject = (method: 'GET' | 'POST', url: string, bearer: string, payload?: object) =>
        app
          .getHttpAdapter()
          .getInstance()
          .inject({
            method,
            url,
            headers: { authorization: `Bearer ${bearer}` },
            ...(payload ? { payload: payload as Record<string, unknown> } : {}),
          });
      const approveBody = (code?: string) => ({
        purpose: 'activate',
        as: 'owner',
        ...(code === undefined ? {} : { evaluation_code: code }),
      });

      const low = await evaluate(w, { current: { resolved: (task) => task < 't-c' } });
      const refused = await inject(
        'POST',
        '/v1/admin/agents/coder/approvals',
        owner,
        approveBody(low.code),
      );
      expect(refused.statusCode).toBe(409);
      expect(body(refused).error).toMatchObject({
        code: 'agent_refused',
        reason: 'evaluation_below_threshold',
      });
      expect(body(refused).error.reason_message).toContain('0.250');
      expect(
        (await inject('POST', '/v1/admin/agents/coder/approvals', owner, approveBody('EVAL-1')))
          .statusCode,
      ).toBe(400);

      const shown = await inject('GET', '/v1/admin/agents/coder', owner);
      expect(body(shown).evaluation).toMatchObject({
        mode: 'required',
        code: low.code,
        result: 'evaluation_below_threshold',
        qualifies: false,
      });

      const good = await evaluate(w, {});
      const accepted = await inject(
        'POST',
        '/v1/admin/agents/coder/approvals',
        owner,
        approveBody(good.code),
      );
      expect(accepted.statusCode, accepted.body).toBe(200);
      expect(body(accepted).evaluation).toMatchObject({
        mode: 'required',
        code: good.code,
        result: 'passed',
        qualifies: true,
        params: { rate: '1.000', tasks: '8' },
      });
      expect(body(accepted).approvals[0]).toMatchObject({
        evaluation_id: good.id,
        evaluation_result: 'passed',
      });
      expect(body(await inject('GET', '/v1/admin/agents/coder', owner)).evaluation).toMatchObject({
        code: good.code,
        qualifies: true,
      });
    });
  });
});
