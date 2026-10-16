// The evaluation plans of the stub API (L05, design/ADR-M82 §2.7): fictional and in memory. Reads
// answer like the API's presenters; writes apply the API's rules the screens depend on: the
// step-up (Run now always; a create or change that turns a schedule or `on_change` on or raises a
// budget), `expected_version`, one waiting run, archived is final. Nothing here is real data.
import { randomUUID } from 'node:crypto';

const NOW = () => new Date().toISOString();
const SHOP = { id: '00000000-0000-4000-8000-000000000902', slug: 'shop' };
const USER = '00000000-0000-4000-8000-000000000001';
const toMicros = (v) => {
  const [w = '0', f = ''] = String(v).split('.');
  return BigInt(w) * 1_000_000n + BigInt(f.padEnd(6, '0'));
};

function version(n, body) {
  return {
    version: n,
    data_class: body.data_class,
    task_set_version: body.task_set_version,
    task_ids: body.task_ids ?? null,
    runs_per_task: body.runs_per_task,
    budget_per_run_usd: body.budget_per_run_usd,
    monthly_cap_usd: body.monthly_cap_usd,
    trigger: body.trigger,
    schedule: body.schedule ?? null,
    configurations: body.configurations.map((c) => ({
      id: c.id,
      agent_key: c.agent_key ?? null,
      model: c.model ?? null,
      provider_type: c.provider_type ?? null,
      max_iterations: c.max_iterations,
      max_duration_min: c.max_duration_min,
      prompt: c.prompt_path
        ? { path: c.prompt_path, commit: 'c'.repeat(40), sha256: 'd'.repeat(64) }
        : null,
    })),
    changed_by: USER,
    created_at: NOW(),
  };
}

const EVALUATION = {
  id: '00000000-0000-4000-8000-000000000501',
  code: 'EVAL-2026-0001',
  project_id: SHOP.id,
  plan_id: null,
  plan_version: null,
  config_name: null,
  data_class: 'internal',
  task_set_version: 1,
  task_ids: ['feat-tax', 'bug-stock'],
  configuration_ids: ['qwen'],
  runs_per_task: 3,
  budget_usd: '6.000000',
  status: 'running',
  stop_reason: null,
  started_by: USER,
  created_at: NOW(),
  finished_at: null,
};

// L06: the report of the evaluation (fictional numbers) and the evaluations that ended lately.
const ENDED = {
  ...EVALUATION,
  id: '00000000-0000-4000-8000-000000000502',
  code: 'EVAL-2026-0002',
  configuration_ids: ['qwen', 'gpt-oss'],
  status: 'completed',
  finished_at: NOW(),
};

const config = (configuration, model, resolved, extra) => ({
  configuration,
  model,
  tasks: 10,
  runs: 30,
  k: 3,
  resolved,
  pass_at_1: resolved.estimate,
  ...extra,
});

const REPORT = {
  evaluation: ENDED,
  final: true,
  results: 60,
  thresholds: {
    alpha: 0.05,
    min_paired_tasks: 8,
    low_ci_first_try_rate: 0.5,
    unstable_gap: 0.3,
    stopped_at_cap_share: 0.2,
  },
  configurations: [
    config(
      'qwen',
      'qwen3-coder:30b',
      { estimate: 0.6, low: 0.43, high: 0.77 },
      {
        pass_at_k: 0.8,
        pass_hat_k: 0.4,
        ci_first_try: 0.37,
        scope_breaches: 0,
        stopped: 3,
        stopped_at_cap: 2,
        median_seconds: 412,
        total_cost_usd: '1.200000',
        cost_per_run_usd: '0.040000',
        cost_per_resolved_usd: '0.066667',
      },
    ),
    config(
      'gpt-oss',
      'gpt-oss:20b',
      { estimate: 0.53, low: 0.37, high: 0.7 },
      {
        pass_at_k: 0.7,
        pass_hat_k: 0.5,
        ci_first_try: 0.6,
        scope_breaches: 1,
        stopped: 1,
        stopped_at_cap: 1,
        median_seconds: 365,
        total_cost_usd: '0.600000',
        cost_per_run_usd: '0.020000',
        cost_per_resolved_usd: '0.037500',
      },
    ),
  ],
  comparisons: [
    {
      a: 'qwen',
      b: 'gpt-oss',
      pairs: 30,
      paired_tasks: 10,
      only_a: 4,
      only_b: 2,
      p_value: 0.6875,
      better: null,
    },
  ],
  recommendations: [
    {
      rule: 'cheaper_model_no_difference',
      configuration: 'gpt-oss',
      other: 'qwen',
      numbers: {
        model: 'gpt-oss:20b',
        other_model: 'qwen3-coder:30b',
        cost_per_run_usd: '0.020000',
        other_cost_per_run_usd: '0.040000',
        paired_tasks: '10',
        resolved: '53%',
        resolved_low: '37%',
        resolved_high: '70%',
        other_resolved: '60%',
        other_resolved_low: '43%',
        other_resolved_high: '77%',
        p_value: '0.688',
      },
    },
    {
      rule: 'low_ci_first_try',
      configuration: 'qwen',
      other: null,
      numbers: { model: 'qwen3-coder:30b', ci_first_try: '11', runs: '30', threshold: '50%' },
    },
    {
      rule: 'unstable_results',
      configuration: 'qwen',
      other: null,
      numbers: { model: 'qwen3-coder:30b', k: '3', pass_at_k: '80%', pass_hat_k: '40%' },
    },
    {
      rule: 'scope_breach',
      configuration: 'gpt-oss',
      other: null,
      numbers: { model: 'gpt-oss:20b', breaches: '1', runs: '30' },
    },
  ],
  real_runs: { available: false, reason: 'no_role' },
};

const plans = [];

function seed() {
  const id = '11111111-1111-4111-8111-111111111111';
  const body = {
    data_class: 'internal',
    task_set_version: 1,
    task_ids: null,
    runs_per_task: 3,
    budget_per_run_usd: '2',
    monthly_cap_usd: '20',
    trigger: 'schedule',
    schedule: { every: 'weekly', hour: 6, weekday: 1 },
    configurations: [
      { id: 'qwen', agent_key: 'openhands-qwen', max_iterations: 30, max_duration_min: 20 },
      {
        id: 'oss-short',
        model: 'gpt-oss-20b',
        provider_type: 'self_hosted',
        max_iterations: 30,
        max_duration_min: 20,
        prompt_path: 'eval/prompts/short.md',
      },
    ],
  };
  plans.push({
    id,
    code: 'weekly-models',
    status: 'active',
    versions: [version(1, body)],
    next_run_at: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    run_requested_at: null,
    last_refusal: 'model_not_allowed',
    last_refusal_at: NOW(),
    created_at: NOW(),
  });
  EVALUATION.plan_id = id;
  EVALUATION.plan_version = 1;
}
seed();

function summary(p) {
  return {
    id: p.id,
    project: SHOP,
    code: p.code,
    version: p.versions.length,
    status: p.status,
    pause_reason: null,
    paused_until: null,
    next_run_at: p.next_run_at,
    run_requested_at: p.run_requested_at,
    last_refusal: p.last_refusal,
    last_refusal_at: p.last_refusal_at,
    created_by: USER,
    created_at: p.created_at,
    updated_at: NOW(),
  };
}

const show = (p) => ({
  ...summary(p),
  can_change: p.status !== 'archived',
  current: p.versions.at(-1),
  versions: p.versions.map((v) => ({
    version: v.version,
    changed_by: v.changed_by,
    created_at: v.created_at,
  })),
  evaluations: p.id === EVALUATION.plan_id ? [EVALUATION] : [],
});

const refuse = (status, code, reason) => ({
  status,
  body: { error: { code, message: code, ...(reason ? { reason } : {}) } },
});

const automatic = (trigger) => trigger === 'schedule' || trigger === 'on_change';

export const evalPlans = {
  read(url) {
    const p = url.pathname;
    if (p === '/v1/projects/shop/eval-plans') {
      return { body: { can_change: true, plans: plans.map(summary) } };
    }
    if (/^\/v1\/projects\/[a-z0-9-]+\/eval-plans$/.test(p)) {
      return { body: { can_change: false, plans: [] } };
    }
    const one = /^\/v1\/eval-plans\/([0-9a-f-]{36})$/.exec(p);
    if (one) {
      const plan = plans.find((x) => x.id === one[1]);
      return plan ? { body: show(plan) } : undefined;
    }
    if (p === '/v1/evaluations/recent') {
      return { body: { since: NOW(), evaluations: [{ ...ENDED, project: 'shop' }] } };
    }
    if (p === `/v1/evaluations/${EVALUATION.code}/report`) {
      return {
        body: {
          ...REPORT,
          evaluation: EVALUATION,
          final: false,
          results: 2,
          configurations: [],
          comparisons: [],
          recommendations: [],
        },
      };
    }
    if (p === `/v1/evaluations/${ENDED.code}/report`) return { body: REPORT };
    if (p === `/v1/evaluations/${ENDED.code}`) {
      return {
        body: {
          ...ENDED,
          runs: { queued: 0, running: 0, preempted: 0, scored: 60, failed: 0, cancelled: 0 },
          spent_usd: '1.80',
        },
      };
    }
    if (p === '/v1/evaluations') {
      return {
        body: { evaluations: url.searchParams.get('project') === 'shop' ? [EVALUATION] : [] },
      };
    }
    if (p === `/v1/evaluations/${EVALUATION.code}`) {
      return {
        body: {
          ...EVALUATION,
          runs: { queued: 2, running: 1, preempted: 0, scored: 2, failed: 1, cancelled: 0 },
          spent_usd: '2.75',
        },
      };
    }
    return undefined;
  },

  async write(url, body, stepUp) {
    const p = url.pathname;
    if (p === '/v1/projects/shop/eval-plans') {
      if (plans.some((x) => x.code === body.code)) {
        return refuse(409, 'evaluation_conflict', 'plan_code_taken');
      }
      if (automatic(body.trigger) && !(await stepUp('eval_plan.create', 'shop'))) {
        return refuse(403, 'step_up_refused');
      }
      const { code, ...rest } = body;
      delete rest.step_up;
      const plan = {
        id: randomUUID(),
        code,
        status: 'active',
        versions: [version(1, rest)],
        next_run_at: null,
        run_requested_at: null,
        last_refusal: null,
        last_refusal_at: null,
        created_at: NOW(),
      };
      plans.push(plan);
      return { status: 201, body: show(plan) };
    }
    const m = /^\/v1\/eval-plans\/([0-9a-f-]{36})\/(versions|archive|runs)$/.exec(p);
    const plan = m && plans.find((x) => x.id === m[1]);
    if (!plan) return refuse(404, 'not_found');
    if (plan.status === 'archived') return refuse(409, 'evaluation_conflict', 'plan_archived');
    if (m[2] === 'archive') {
      plan.status = 'archived';
      plan.run_requested_at = null;
      return { status: 200, body: show(plan) };
    }
    if (m[2] === 'runs') {
      if (!(await stepUp('eval_plan.run', plan.id))) return refuse(403, 'step_up_refused');
      plan.run_requested_at = plan.run_requested_at ?? NOW();
      plan.last_refusal = null;
      plan.last_refusal_at = null;
      return { status: 202, body: show(plan) };
    }
    if (body.expected_version !== plan.versions.length) {
      return refuse(409, 'evaluation_conflict', 'plan_changed');
    }
    const before = plan.versions.at(-1);
    const needs =
      (automatic(body.trigger) && !automatic(before.trigger)) ||
      toMicros(body.budget_per_run_usd) > toMicros(before.budget_per_run_usd) ||
      toMicros(body.monthly_cap_usd) > toMicros(before.monthly_cap_usd);
    if (needs && !(await stepUp('eval_plan.change', plan.id)))
      return refuse(403, 'step_up_refused');
    const rest = { ...body };
    delete rest.expected_version;
    delete rest.step_up;
    plan.versions.push(version(plan.versions.length + 1, rest));
    return { status: 201, body: show(plan) };
  },
};
