// Evaluation plans in the dashboard (task L05, design/ADR-M82): the form's state, the body it
// sends, and when a passkey step-up is needed. Pure: no DOM. The API checks everything again; these
// checks only say early which field is wrong.
import type { EvalPlanView } from '@sdlc/api-schemas';

export type Trigger = 'once' | 'schedule' | 'on_change';
export type Source = 'agent' | 'model';

export interface ConfigForm {
  readonly id: string;
  readonly source: Source;
  readonly agentKey: string;
  readonly model: string;
  readonly providerType: 'self_hosted' | 'api';
  readonly maxIterations: string;
  readonly maxDurationMin: string;
  /** A file on the project's default branch; never the prompt's text. */
  readonly promptPath: string;
}

export interface PlanForm {
  readonly code: string;
  readonly dataClass: string;
  /** A task set number, or `project`: the project's approved tasks (L07, ADR-M85 §2.10). */
  readonly taskSetVersion: string;
  /** Task IDs separated by commas; empty: every task of the set. */
  readonly taskIds: string;
  readonly runsPerTask: string;
  readonly budgetPerRunUsd: string;
  readonly monthlyCapUsd: string;
  readonly trigger: Trigger;
  readonly every: 'daily' | 'weekly';
  readonly hour: string;
  readonly weekday: string;
  readonly configurations: readonly ConfigForm[];
}

export const DATA_CLASS_CHOICES = [
  'public',
  'internal',
  'client_confidential',
  'client_restricted',
];
export const MAX_CONFIGURATIONS = 16;
/** The word the task set field takes for the project's own tasks. */
export const PROJECT_TASK_SET = 'project';

export const emptyConfig = (index: number): ConfigForm => ({
  id: `config-${String(index + 1)}`,
  source: 'agent',
  agentKey: '',
  model: '',
  providerType: 'self_hosted',
  maxIterations: '30',
  maxDurationMin: '20',
  promptPath: '',
});

export const emptyPlanForm = (): PlanForm => ({
  code: '',
  dataClass: 'internal',
  taskSetVersion: '1',
  taskIds: '',
  runsPerTask: '3',
  budgetPerRunUsd: '1',
  monthlyCapUsd: '10',
  trigger: 'once',
  every: 'weekly',
  hour: '6',
  weekday: '1',
  configurations: [emptyConfig(0)],
});

/** The form of a plan's current version, to change it. */
export function planFormOf(plan: EvalPlanView): PlanForm {
  const c = plan.current;
  return {
    code: plan.code,
    dataClass: c.data_class,
    taskSetVersion: c.task_set_version === null ? PROJECT_TASK_SET : String(c.task_set_version),
    taskIds: (c.task_ids ?? []).join(', '),
    runsPerTask: String(c.runs_per_task),
    budgetPerRunUsd: c.budget_per_run_usd,
    monthlyCapUsd: c.monthly_cap_usd,
    trigger: (c.trigger as Trigger) ?? 'once',
    every: c.schedule?.every === 'daily' ? 'daily' : 'weekly',
    hour: String(c.schedule?.hour ?? 6),
    weekday: String(c.schedule?.weekday ?? 1),
    configurations: c.configurations.map((x) => ({
      id: x.id,
      source: x.agent_key === null ? 'model' : 'agent',
      agentKey: x.agent_key ?? '',
      model: x.model ?? '',
      providerType: x.provider_type === 'api' ? 'api' : 'self_hosted',
      maxIterations: String(x.max_iterations),
      maxDurationMin: String(x.max_duration_min),
      promptPath: x.prompt?.path ?? '',
    })),
  };
}

const PLAN_CODE = /^[a-z][a-z0-9-]{0,47}$/;
const CONFIG_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const AGENT_KEY = /^[a-z][a-z0-9-]{0,62}[a-z0-9]$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;
const TASK = /^[a-z][a-z0-9_.-]{0,63}$/;
const USD = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/;
const PATH = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+){0,15}$/;

function int(value: string, min: number, max: number): number | null {
  if (!/^[0-9]{1,6}$/.test(value.trim())) return null;
  const n = Number(value.trim());
  return n >= min && n <= max ? n : null;
}

/** USD as integer micro-dollars (never a float), or null. */
export function micros(value: string): bigint | null {
  const text = value.trim();
  if (!USD.test(text)) return null;
  const [whole = '0', fraction = ''] = text.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}

export type BodyResult =
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly field: string };

/** The API body of the form (`code` only when creating), or the first wrong field. */
export function planBody(form: PlanForm, mode: 'create' | 'change'): BodyResult {
  const bad = (field: string): BodyResult => ({ ok: false, field });
  if (mode === 'create' && !PLAN_CODE.test(form.code.trim())) return bad('code');
  if (!DATA_CLASS_CHOICES.includes(form.dataClass)) return bad('data_class');
  const project = form.taskSetVersion.trim().toLowerCase() === PROJECT_TASK_SET;
  const taskSet = project ? null : int(form.taskSetVersion, 1, 1000);
  if (!project && taskSet === null) return bad('task_set_version');
  const tasks = form.taskIds
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x !== '');
  if (tasks.length > 64 || tasks.some((x) => !TASK.test(x))) return bad('task_ids');
  const runs = int(form.runsPerTask, 1, 20);
  if (runs === null) return bad('runs_per_task');
  const perRun = micros(form.budgetPerRunUsd);
  if (perRun === null || perRun <= 0n) return bad('budget_per_run_usd');
  const cap = micros(form.monthlyCapUsd);
  if (cap === null || cap < perRun) return bad('monthly_cap_usd');
  let schedule: Record<string, unknown> | null = null;
  if (form.trigger === 'schedule') {
    const hour = int(form.hour, 0, 23);
    if (hour === null) return bad('hour');
    const weekday = form.every === 'weekly' ? int(form.weekday, 1, 7) : null;
    if (form.every === 'weekly' && weekday === null) return bad('weekday');
    schedule = { every: form.every, hour, weekday };
  }
  if (form.configurations.length < 1 || form.configurations.length > MAX_CONFIGURATIONS) {
    return bad('configurations');
  }
  const ids = new Set<string>();
  const configurations: Record<string, unknown>[] = [];
  for (const c of form.configurations) {
    const id = c.id.trim();
    if (!CONFIG_ID.test(id) || ids.has(id)) return bad('configuration_id');
    ids.add(id);
    const iterations = int(c.maxIterations, 1, 200);
    const minutes = int(c.maxDurationMin, 1, 120);
    if (iterations === null) return bad('max_iterations');
    if (minutes === null) return bad('max_duration_min');
    const promptPath = c.promptPath.trim();
    if (promptPath !== '' && (!PATH.test(promptPath) || /(^|\/)\.+(\/|$)/.test(promptPath))) {
      return bad('prompt_path');
    }
    if (c.source === 'agent') {
      if (!AGENT_KEY.test(c.agentKey.trim())) return bad('agent_key');
    } else if (!MODEL.test(c.model.trim())) {
      return bad('model');
    }
    configurations.push({
      id,
      agent_key: c.source === 'agent' ? c.agentKey.trim() : null,
      model: c.source === 'model' ? c.model.trim() : null,
      provider_type: c.source === 'model' ? c.providerType : null,
      max_iterations: iterations,
      max_duration_min: minutes,
      prompt_path: promptPath === '' ? null : promptPath,
    });
  }
  return {
    ok: true,
    body: {
      ...(mode === 'create' ? { code: form.code.trim() } : {}),
      data_class: form.dataClass,
      task_set_kind: project ? 'project' : 'folder',
      task_set_version: taskSet,
      task_ids: tasks.length === 0 ? null : tasks,
      runs_per_task: runs,
      budget_per_run_usd: form.budgetPerRunUsd.trim(),
      monthly_cap_usd: form.monthlyCapUsd.trim(),
      trigger: form.trigger,
      schedule,
      configurations,
    },
  };
}

/**
 * Whether a create or change needs the passkey step-up (ADR-M82 §2.7, the API's rule): it turns a
 * schedule or `on_change` on, or raises the budget per run or the monthly cap.
 */
export function needsStepUp(
  before: { readonly trigger: string; readonly perRun: string; readonly cap: string } | null,
  body: Readonly<Record<string, unknown>>,
): boolean {
  const automatic = (trigger: unknown) => trigger === 'schedule' || trigger === 'on_change';
  if (automatic(body.trigger) && (before === null || !automatic(before.trigger))) return true;
  if (before === null) return false;
  const up = (now: unknown, was: string) => (micros(String(now)) ?? 0n) > (micros(was) ?? 0n);
  return up(body.budget_per_run_usd, before.perRun) || up(body.monthly_cap_usd, before.cap);
}

/** The body a step-up is bound to: the request without `step_up`, with decision and target. */
export function stepUpRequest(
  body: Readonly<Record<string, unknown>>,
  decision: 'create' | 'change' | 'run',
  target: string,
): Record<string, unknown> {
  return { ...body, decision, target };
}

/** The catalog key of a refusal: the API's reason when it has one. */
export function evalErrorKey(error: { readonly code: string; readonly reason?: string }): string {
  if (error.reason !== undefined && /^[a-z_]{1,64}$/.test(error.reason)) {
    return `evaluation.error.${error.reason}`;
  }
  if (error.code === 'step_up_refused') return 'dashboard.eval.error.step_up';
  if (error.code === 'dashboard_actions_off') return 'dashboard.passkeys.error.actions_off';
  if (error.code === 'passkey_not_found') return 'dashboard.eval.error.no_passkey';
  return 'dashboard.eval.error.failed';
}

/** An action of a plan screen: one API write, maybe after a passkey. */
export type PlanAction = () => Promise<unknown>;

// The catalog keys of the codes the screens show, written out so a test finds every key.
export const PLAN_STATUS_KEYS: Readonly<Record<string, string>> = {
  active: 'dashboard.eval.status.active',
  paused: 'dashboard.eval.status.paused',
  archived: 'dashboard.eval.status.archived',
};

export const WEEKDAY_KEYS: Readonly<Record<string, string>> = {
  '1': 'dashboard.eval.weekday.1',
  '2': 'dashboard.eval.weekday.2',
  '3': 'dashboard.eval.weekday.3',
  '4': 'dashboard.eval.weekday.4',
  '5': 'dashboard.eval.weekday.5',
  '6': 'dashboard.eval.weekday.6',
  '7': 'dashboard.eval.weekday.7',
};

export const WHEN_KEYS = {
  once: 'dashboard.eval.when.once',
  on_change: 'dashboard.eval.when.on_change',
  daily: 'dashboard.eval.when.daily',
  weekly: 'dashboard.eval.when.weekly',
} as const;

export const TRIGGER_CHOICE_KEYS: Readonly<Record<Trigger, string>> = {
  once: 'dashboard.eval.when.choice.once',
  schedule: 'dashboard.eval.when.choice.schedule',
  on_change: 'dashboard.eval.when.choice.on_change',
};

export const RUN_STATE_KEYS = {
  queued: 'dashboard.eval.run_state.queued',
  running: 'dashboard.eval.run_state.running',
  preempted: 'dashboard.eval.run_state.preempted',
  scored: 'dashboard.eval.run_state.scored',
  failed: 'dashboard.eval.run_state.failed',
  cancelled: 'dashboard.eval.run_state.cancelled',
} as const;

export const INVALID_FIELD_KEYS: Readonly<Record<string, string>> = {
  code: 'dashboard.eval.form.invalid.code',
  data_class: 'dashboard.eval.form.invalid.data_class',
  task_set_version: 'dashboard.eval.form.invalid.task_set_version',
  task_ids: 'dashboard.eval.form.invalid.task_ids',
  runs_per_task: 'dashboard.eval.form.invalid.runs_per_task',
  budget_per_run_usd: 'dashboard.eval.form.invalid.budget_per_run_usd',
  monthly_cap_usd: 'dashboard.eval.form.invalid.monthly_cap_usd',
  hour: 'dashboard.eval.form.invalid.hour',
  weekday: 'dashboard.eval.form.invalid.weekday',
  configurations: 'dashboard.eval.form.invalid.configurations',
  configuration_id: 'dashboard.eval.form.invalid.configuration_id',
  max_iterations: 'dashboard.eval.form.invalid.max_iterations',
  max_duration_min: 'dashboard.eval.form.invalid.max_duration_min',
  prompt_path: 'dashboard.eval.form.invalid.prompt_path',
  agent_key: 'dashboard.eval.form.invalid.agent_key',
  model: 'dashboard.eval.form.invalid.model',
};
