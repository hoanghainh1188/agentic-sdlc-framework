// `sdlc ops eval start`: an evaluation on the server (task L04, design/ADR-M81 §2.7, QUESTIONS
// #464). An operator command with SDLC_DB_URL (`platform_app`), audited as actor `system`. The API,
// the CLI for people and the schedules come with L05. It reads the configuration file and the task
// set, checks the project, the data class and the models (`startEvaluation`), and queues one run
// per configuration × task × run number. The worker's evaluation loop and the runner do the rest.
// It prints the evaluation code and counts only: never a task, a prompt or a path.
import path from 'node:path';
import { parseArgs } from 'node:util';

import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';
import { DATA_CLASSES, type DataClass } from '@sdlc/contracts';
import {
  EvaluationError,
  isUsd,
  startEvaluation,
  type EvaluationErrorCode,
  type TenantScope,
} from '@sdlc/core';
import { loadConfigurations, loadTaskSet, providerTypeOf, TaskError } from '@sdlc/eval';
import { t, type MessageKey } from '@sdlc/messages';

import { EXIT, type CliContext } from '../context.js';

type Values = Record<string, string | boolean | undefined>;

const SPEC = {
  tenant: { type: 'string' },
  project: { type: 'string' },
  config: { type: 'string' },
  configurations: { type: 'string' },
  tasks: { type: 'string' },
  'tasks-dir': { type: 'string' },
  n: { type: 'string' },
  budget: { type: 'string' },
  'data-class': { type: 'string' },
  json: { type: 'boolean', default: false },
} as const;

const REQUIRED = ['tenant', 'project', 'config', 'budget'] as const;

/** The task set packed with the repository; `SDLC_EVAL_TASKS_DIR` or `--tasks-dir` replace it. */
const DEFAULT_TASKS_DIR = 'platform/eval/tasks/v1';
/** The sample repository's tasks are fictional: `internal` unless the operator says otherwise. */
const DEFAULT_DATA_CLASS: DataClass = 'internal';
const DEFAULT_RUNS = 5;

const ERROR_KEYS: Readonly<Record<EvaluationErrorCode, MessageKey>> = {
  project_not_found: 'cli.ops.eval.error.project_not_found',
  project_not_active: 'cli.ops.eval.error.project_not_active',
  data_class_prohibited: 'cli.ops.eval.error.data_class_prohibited',
  ai_record_missing: 'cli.ops.eval.error.ai_record_missing',
  data_class_not_allowed: 'cli.ops.eval.error.data_class_not_allowed',
  model_not_allowed: 'cli.ops.eval.error.model_not_allowed',
  self_hosted_only: 'cli.ops.eval.error.self_hosted_only',
  invalid_input: 'cli.ops.eval.error.invalid_input',
  forbidden: 'evaluation.error.forbidden',
  plan_not_found: 'evaluation.error.plan_not_found',
  plan_code_taken: 'evaluation.error.plan_code_taken',
  plan_archived: 'evaluation.error.plan_archived',
  plan_paused: 'evaluation.error.plan_paused',
  plan_changed: 'evaluation.error.plan_changed',
  evaluation_open: 'evaluation.error.evaluation_open',
  monthly_cap_used: 'evaluation.error.monthly_cap_used',
  cap_below_spent: 'evaluation.error.cap_below_spent',
  task_set_not_found: 'evaluation.error.task_set_not_found',
  task_not_found: 'evaluation.error.task_not_found',
  agent_not_found: 'evaluation.error.agent_not_found',
  agent_not_active: 'evaluation.error.agent_not_active',
  agent_no_model: 'evaluation.error.agent_no_model',
  prompt_not_found: 'evaluation.error.prompt_not_found',
  git_host_unavailable: 'evaluation.error.git_host_unavailable',
};

const list = (value: string | boolean | undefined): string[] | undefined =>
  typeof value === 'string' && value.trim() !== ''
    ? value.split(',').map((v) => v.trim())
    : undefined;

/** Parses `args` (after `ops eval`). Undefined: print the usage. */
export function parseEvalCommand(
  args: readonly string[],
): { command: 'start'; values: Values } | undefined {
  const [first, ...rest] = args;
  if (first !== 'start') return undefined;
  try {
    const { values } = parseArgs({
      args: [...rest],
      options: SPEC,
      strict: true,
      allowPositionals: false,
    });
    const found = values as Values;
    return REQUIRED.every((key) => typeof found[key] === 'string')
      ? { command: 'start', values: found }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Queues the evaluation as the system. Returns the exit code. */
export async function runEvalCommand(
  scope: TenantScope,
  _command: 'start',
  values: Values,
  ctx: CliContext,
): Promise<number> {
  const runs = values.n === undefined ? DEFAULT_RUNS : Number(values.n);
  const dataClass = String(values['data-class'] ?? DEFAULT_DATA_CLASS);
  const budget = String(values.budget);
  if (
    !Number.isInteger(runs) ||
    !(DATA_CLASSES as readonly string[]).includes(dataClass) ||
    !isUsd(budget)
  ) {
    ctx.stderr(t('cli.ops.eval.usage'));
    return EXIT.usage;
  }
  const project = await scope.projects.getBySlug(String(values.project));
  if (!project) {
    ctx.stderr(t(ERROR_KEYS.project_not_found));
    return EXIT.failed;
  }
  const base = ctx.cwd ?? process.cwd();
  const tasksDir = path.resolve(
    base,
    String(values['tasks-dir'] ?? ctx.env.SDLC_EVAL_TASKS_DIR ?? DEFAULT_TASKS_DIR),
  );
  const configFile = path.resolve(base, String(values.config));
  let set;
  let configurations;
  try {
    set = loadTaskSet(tasksDir, list(values.tasks));
    configurations = loadConfigurations(configFile, list(values.configurations));
  } catch (error) {
    if (!(error instanceof TaskError)) throw error;
    ctx.stderr(t('cli.ops.eval.error.config', { reason: error.message }));
    return EXIT.failed;
  }
  try {
    const evaluation = await startEvaluation(
      scope,
      {
        projectId: project.id,
        dataClass: dataClass as DataClass,
        taskSetVersion: set.version,
        configName: path.basename(configFile).replace(/\.ya?ml$/, ''),
        baseSha: set.commit,
        taskIds: set.tasks.map((task) => task.id),
        configurations: configurations.map((c) => ({
          id: c.id,
          model: c.model.name,
          providerType: providerTypeOf(c.model.provider),
          agentVersion: c.agentVersion,
          maxIterations: c.maxIterations,
          maxDurationMin: c.maxDurationMin,
        })),
        runsPerTask: runs,
        budgetUsd: budget,
        startedBy: null,
      },
      {
        policyFactory: (config, models) => createSimplePolicyEngine({ config, models }),
      },
    );
    const total = set.tasks.length * configurations.length * runs;
    if (values.json === true) {
      ctx.stdout(
        JSON.stringify({
          evaluation: evaluation.code,
          id: evaluation.id,
          runs: total,
          data_class: evaluation.data_class,
          budget_usd: evaluation.budget_usd,
        }),
      );
    } else {
      ctx.stdout(
        t('cli.ops.eval.started', {
          code: evaluation.code,
          runs: total,
          configurations: configurations.length,
          tasks: set.tasks.length,
          n: runs,
          budget: evaluation.budget_usd,
          data_class: evaluation.data_class,
          project: String(values.project),
        }),
      );
    }
    return EXIT.ok;
  } catch (error) {
    if (!(error instanceof EvaluationError)) throw error;
    ctx.stderr(t(ERROR_KEYS[error.code]));
    return EXIT.failed;
  }
}
