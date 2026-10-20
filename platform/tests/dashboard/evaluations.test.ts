// L05 (ADR-M82 §2.7): the dashboard's evaluation plan model, without a browser: the routes, the
// body of the form (codes, numbers, amounts, a path; never a prompt text), when a passkey is
// needed (the API's rule), the body a step-up is bound to, and the refusal messages.
import fs from 'node:fs';
import path from 'node:path';

import { recommendationKey, type RecommendationRule } from '@sdlc/eval';
import { describe, expect, it } from 'vitest';

import {
  emptyPlanForm,
  evalErrorKey,
  micros,
  needsStepUp,
  planBody,
  planFormOf,
  stepUpRequest,
  type PlanForm,
} from '../../apps/dashboard/src/model/evaluations.js';
import {
  comparisonMessage,
  percent,
  pValue,
  realRunsState,
  recommendationMessage,
  RULE_KEYS,
  withInterval,
} from '../../apps/dashboard/src/model/report.js';
import { evaluationHref, parseRoute, planHref } from '../../apps/dashboard/src/model/route.js';
import { evalPlanBody } from '../cli/fixtures.js';
import { repoRoot } from '../workspace/helpers';

const en = JSON.parse(
  fs.readFileSync(path.join(repoRoot(), 'platform/packages/messages/src/locales/en.json'), 'utf8'),
) as Record<string, string>;

/** Every rule of `@sdlc/eval`: the type check fails when a rule is added and not listed here. */
const EVERY_RULE: Readonly<Record<RecommendationRule, true>> = {
  cheaper_model_no_difference: true,
  low_ci_first_try: true,
  unstable_results: true,
  stopped_at_cap: true,
  scope_breach: true,
};

const PLAN = '88888888-8888-4888-8888-888888888888';

describe('routes', () => {
  it('parses the evaluation screens and refuses anything else', () => {
    expect(parseRoute('#/evaluations?project=shop').name).toBe('evaluations');
    expect(parseRoute(`#/evaluations/plans/${PLAN}`)).toMatchObject({
      name: 'eval-plan',
      id: PLAN,
    });
    expect(parseRoute(`#/evaluations/plans/${PLAN}/edit`)).toMatchObject({
      name: 'eval-plan-edit',
      id: PLAN,
    });
    expect(parseRoute('#/evaluations/plans/new?project=shop').name).toBe('eval-plan-new');
    expect(parseRoute('#/evaluations/EVAL-2026-0001')).toMatchObject({
      name: 'evaluation',
      code: 'EVAL-2026-0001',
    });
    expect(parseRoute('#/evaluations/plans/not-a-uuid').name).toBe('evaluations');
    expect(planHref('../x')).toBe('#/evaluations');
    expect(evaluationHref('INT-2026-0001')).toBe('#/evaluations');
  });
});

describe('the form', () => {
  const form = (over: Partial<PlanForm> = {}): PlanForm => ({
    ...emptyPlanForm(),
    code: 'weekly-models',
    configurations: [
      { ...emptyPlanForm().configurations[0]!, id: 'qwen', agentKey: 'openhands-qwen' },
      {
        ...emptyPlanForm().configurations[0]!,
        id: 'oss-short',
        source: 'model',
        model: 'gpt-oss-20b',
        promptPath: 'eval/prompts/short.md',
      },
    ],
    ...over,
  });

  it('builds the API body: codes, numbers, amounts and a path', () => {
    expect(planBody(form({ taskIds: 'feat-tax, bug-stock' }), 'create')).toEqual({
      ok: true,
      body: {
        code: 'weekly-models',
        data_class: 'internal',
        task_set_kind: 'folder',
        task_set_version: 1,
        task_ids: ['feat-tax', 'bug-stock'],
        runs_per_task: 3,
        budget_per_run_usd: '1',
        monthly_cap_usd: '10',
        trigger: 'once',
        schedule: null,
        configurations: [
          {
            id: 'qwen',
            agent_key: 'openhands-qwen',
            model: null,
            provider_type: null,
            max_iterations: 30,
            max_duration_min: 20,
            prompt_path: null,
          },
          {
            id: 'oss-short',
            agent_key: null,
            model: 'gpt-oss-20b',
            provider_type: 'self_hosted',
            max_iterations: 30,
            max_duration_min: 20,
            prompt_path: 'eval/prompts/short.md',
          },
        ],
      },
    });
    // A change sends no code; a schedule has its day and hour.
    const changed = planBody(form({ trigger: 'schedule', every: 'weekly', hour: '6' }), 'change');
    expect(changed.ok && changed.body).toMatchObject({
      schedule: { every: 'weekly', hour: 6, weekday: 1 },
    });
    expect(changed.ok && 'code' in changed.body).toBe(false);
  });

  it.each([
    [{ code: 'Weekly' }, 'code'],
    [{ runsPerTask: '0' }, 'runs_per_task'],
    [{ budgetPerRunUsd: '1.1234567' }, 'budget_per_run_usd'],
    [{ budgetPerRunUsd: '5', monthlyCapUsd: '4' }, 'monthly_cap_usd'],
    [{ taskIds: 'feat tax' }, 'task_ids'],
    [{ trigger: 'schedule' as const, hour: '24' }, 'hour'],
  ])('names the first wrong field: %j', (over, field) => {
    expect(planBody(form(over), 'create')).toEqual({ ok: false, field });
  });

  it('refuses a prompt path out of the repository and a repeated configuration ID', () => {
    const base = form();
    const withPath = (promptPath: string) =>
      planBody({ ...base, configurations: [{ ...base.configurations[1]!, promptPath }] }, 'create');
    expect(withPath('../secret.md')).toEqual({ ok: false, field: 'prompt_path' });
    expect(withPath('/etc/passwd')).toEqual({ ok: false, field: 'prompt_path' });
    expect(
      planBody(
        { ...base, configurations: [base.configurations[0]!, base.configurations[0]!] },
        'create',
      ),
    ).toEqual({ ok: false, field: 'configuration_id' });
  });

  it('reads a plan back into the form', () => {
    const view = evalPlanBody() as Parameters<typeof planFormOf>[0];
    expect(planFormOf(view)).toMatchObject({
      code: 'weekly-models',
      trigger: 'schedule',
      every: 'weekly',
      hour: '6',
      budgetPerRunUsd: '2.5',
      configurations: [{ id: 'oss-short', source: 'model', promptPath: 'eval/prompts/short.md' }],
    });
  });
  it("takes the project's own tasks as the word project, and keeps it on a change (L07)", () => {
    const result = planBody(form({ taskSetVersion: ' Project ' }), 'change');
    expect(result.ok && result.body).toMatchObject({
      task_set_kind: 'project',
      task_set_version: null,
    });
    expect(planBody(form({ taskSetVersion: 'v1' }), 'create')).toEqual({
      ok: false,
      field: 'task_set_version',
    });
    const view = evalPlanBody() as Parameters<typeof planFormOf>[0];
    const project = { ...view, current: { ...view.current, task_set_version: null } };
    expect(planFormOf(project).taskSetVersion).toBe('project');
  });
});

describe('the passkey step-up', () => {
  const before = { trigger: 'once', perRun: '1', cap: '10' };
  it('follows the API rule: a schedule or on_change turned on, or a higher budget', () => {
    expect(needsStepUp(null, { trigger: 'once' })).toBe(false);
    expect(needsStepUp(null, { trigger: 'schedule' })).toBe(true);
    expect(
      needsStepUp(before, { trigger: 'on_change', budget_per_run_usd: '1', monthly_cap_usd: '10' }),
    ).toBe(true);
    expect(
      needsStepUp(before, { trigger: 'once', budget_per_run_usd: '1.5', monthly_cap_usd: '10' }),
    ).toBe(true);
    expect(
      needsStepUp(before, { trigger: 'once', budget_per_run_usd: '0.5', monthly_cap_usd: '8' }),
    ).toBe(false);
    expect(
      needsStepUp(
        { trigger: 'schedule', perRun: '1', cap: '10' },
        { trigger: 'schedule', budget_per_run_usd: '1', monthly_cap_usd: '10' },
      ),
    ).toBe(false);
  });

  it('binds the step-up to the body with the decision and the target', () => {
    expect(stepUpRequest({ runs_per_task: 2 }, 'change', PLAN)).toEqual({
      runs_per_task: 2,
      decision: 'change',
      target: PLAN,
    });
    expect(micros('0.000001')).toBe(1n);
    expect(micros('1e3')).toBeNull();
  });

  it('shows the API reason from the catalog', () => {
    expect(evalErrorKey({ code: 'evaluation_conflict', reason: 'plan_changed' })).toBe(
      'evaluation.error.plan_changed',
    );
    expect(evalErrorKey({ code: 'step_up_refused' })).toBe('dashboard.eval.error.step_up');
    expect(evalErrorKey({ code: 'x', reason: '<b>' })).toBe('dashboard.eval.error.failed');
  });
});

// L06 (ADR-M83 §2.2, §2.3): the report page's model. Rates with their intervals, a difference only
// when the API found one, recommendations from the catalog with the numbers they rest on.
describe('the evaluation report', () => {
  const interval = { estimate: 0.425, low: 0.31, high: 0.555 };

  it('shows every rate with its interval and p-values without false precision', () => {
    expect(percent(0.005)).toBe('1%');
    expect(withInterval(interval)).toBe('43% (31%–56%)');
    expect(pValue(0.04321)).toBe('0.043');
    expect(pValue(0.0001)).toBe('< 0.001');
  });

  it('calls a difference only when the API names the better configuration', () => {
    const base = { a: 'cfg-a', b: 'cfg-b', pairs: 20, paired_tasks: 10, only_a: 1, only_b: 2 };
    expect(comparisonMessage({ ...base, p_value: 0.6, better: null })).toEqual({
      key: 'dashboard.eval.report.no_difference',
      params: { a: 'cfg-a', b: 'cfg-b', better: '', tasks: 10, p: '0.6' },
    });
    expect(comparisonMessage({ ...base, p_value: 0.01, better: 'cfg-b' }).key).toBe(
      'dashboard.eval.report.difference',
    );
  });

  it('maps every rule to the same catalog key as @sdlc/eval, and an unknown rule to none', () => {
    for (const rule of Object.keys(RULE_KEYS))
      expect(RULE_KEYS[rule]).toBe(recommendationKey(rule));
    expect(Object.keys(RULE_KEYS).sort()).toEqual(Object.keys(EVERY_RULE).sort());
    const rec = {
      rule: 'scope_breach',
      configuration: 'cfg-a',
      other: null,
      numbers: { breaches: '2', runs: '10', model: 'm' },
    };
    expect(recommendationMessage(rec)).toEqual({
      key: 'eval.recommendation.scope_breach',
      params: { configuration: 'cfg-a', other: '', breaches: '2', runs: '10', model: 'm' },
    });
    expect(recommendationMessage({ ...rec, rule: 'newer_rule' })).toBeUndefined();
  });

  it('every recommendation key and the register note are in the catalog', () => {
    for (const key of [...Object.values(RULE_KEYS), 'eval.recommendation.register_note']) {
      expect(en[key], key).toBeTypeOf('string');
    }
  });

  it('shows real runs only when the API gave them', () => {
    expect(realRunsState(null)).toBe('hidden');
    expect(realRunsState({ available: false, reason: 'no_role' })).toBe('hidden');
  });
});
