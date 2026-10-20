// Evaluation plans that managers make themselves (task L05, design/ADR-M82, QUESTIONS #470–#475).
//
// - Who: a tenant admin, or a person with a role on the project in `access.eval_roles` (never
//   `viewer`, rule M33). No role on the project → `project_not_found`; another role → `forbidden`.
//   An automatic start (a schedule, `on_change`) acts as the system.
// - A configuration is an agent of the register (its current version, model and tools when a run
//   starts; `proposed`, `active` or `suspended`, ADR-M86 §2.2) or a model by name with the project's default agent (`run.agent_key`), and an optional prompt
//   variant: a file on the project's default branch. The platform reads it when the plan is saved
//   and again when a run starts, and keeps only the path, the commit and the SHA-256.
// - Budgets (QUESTIONS #473): a budget per run, a monthly cap per plan (UTC month), and the
//   tenant's monthly budget when the key is issued (L04). A used-up cap pauses the plan until the
//   next month and refuses a start. Amounts change only by a new version, never below the month's
//   spend.
// - One open evaluation per plan (a unique index as well).
import { createHash } from 'node:crypto';

import { canonicalJson } from '@sdlc/config';
import {
  GitHostError,
  type AgentStatus,
  type DataClass,
  type GitHostAdapter,
  type ModelRef,
  type ProviderType,
} from '@sdlc/contracts';

import { isTenantAdmin } from '../admin/actor.js';
import { fromMicros, startOfUtcMonth, toMicros } from '../cost/money.js';
import { DbError } from '../db/errors.js';
import type {
  EvaluationConfigurationInput,
  EvaluationFromPlan,
  NewEvaluation,
} from '../db/repositories/evaluations.js';
import {
  checkPlanContent,
  planVersionView,
  type PlanConfiguration,
  type PlanContent,
  type PlanSchedule,
  type PlanVersionView,
} from '../db/repositories/evaluation-plans.js';
import type { Agent, Evaluation, EvaluationPlan, Project } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import type { EvaluationPlanTrigger, TaskSetKind } from '../db/vocabulary.js';
import { loadEffectiveConfig } from '../registry/effective-config.js';
import { projectRepoRef } from '../workflow/g4-proposal.js';
import { EvaluationError } from './errors.js';
import { checkProjectTaskSet, readProjectTaskSet } from './project-task-set.js';
import { checkEvaluationScope, type EvaluationPolicyFactory } from './start.js';

/** The pause reason of a plan whose monthly cap is used up. */
export const MONTHLY_CAP_USED = 'monthly_cap_used';

/** A task set the server knows: its version, the commit its tasks start from, its task IDs. */
export interface KnownTaskSet {
  readonly version: number;
  readonly baseSha: string;
  readonly taskIds: readonly string[];
}

export interface EvaluationPlanDeps {
  readonly policyFactory: EvaluationPolicyFactory;
  /**
   * The gateway's current model list. The worker has it; the api does not (QUESTIONS #476): then
   * the models are checked when the worker starts a run.
   */
  readonly models?: () => Promise<readonly ModelRef[]>;
  /** The task sets this server has (the runner image's v1, `SDLC_EVAL_TASKS_DIR`); worker only. */
  readonly taskSet?: (version: number) => Promise<KnownTaskSet | undefined>;
  /** Reads a prompt variant from the default branch; the text is hashed, never kept. */
  readonly gitHost: Pick<GitHostAdapter, 'getBranchHead' | 'getFileAtCommit'>;
  /** Default: `new Date()`. */
  readonly now?: () => Date;
}

/** A configuration as a person enters it: the prompt variant is a path only. */
export interface PlanConfigurationInput {
  readonly id: string;
  readonly agentKey?: string | null;
  readonly model?: string | null;
  readonly providerType?: ProviderType | null;
  readonly maxIterations: number;
  readonly maxDurationMin: number;
  readonly promptPath?: string | null;
}

export interface PlanContentInput {
  readonly dataClass: DataClass;
  /** L07 (ADR-M85 §2.10): default `folder`; `project` runs the project's approved tasks. */
  readonly taskSetKind?: TaskSetKind;
  /** The number of a `folder` task set; null for `project`. */
  readonly taskSetVersion: number | null;
  readonly taskIds?: readonly string[] | null;
  readonly runsPerTask: number;
  readonly budgetPerRunUsd: string;
  readonly monthlyCapUsd: string;
  readonly trigger: EvaluationPlanTrigger;
  readonly schedule?: PlanSchedule | null;
  readonly configurations: readonly PlanConfigurationInput[];
}

export type PlanActor =
  | { readonly type: 'human'; readonly userId: string }
  | { readonly type: 'system'; readonly reason: 'schedule' | 'on_change' };

const now = (deps: Pick<EvaluationPlanDeps, 'now'>): Date => (deps.now ? deps.now() : new Date());

/** Refuses a person who may not run evaluations of the project (ADR-M82 §2.2). */
export async function assertEvalRole(
  scope: TenantScope,
  userId: string,
  projectId: string,
): Promise<void> {
  if (await isTenantAdmin(scope, userId)) return;
  const roles = (await scope.roleBindings.listForUser(userId))
    .filter((binding) => binding.project_id === projectId)
    .map((binding) => binding.role);
  if (roles.length === 0) {
    throw new EvaluationError('project_not_found', 'no role on the project');
  }
  const { config } = await loadEffectiveConfig(scope.projectConfigs, projectId);
  if (!roles.some((role) => config.access.eval_roles.includes(role))) {
    throw new EvaluationError('forbidden', 'no role in access.eval_roles');
  }
}

/** True when the person may change and run the project's plans (QUESTIONS #477): for the UI. */
export async function mayChangePlans(
  scope: TenantScope,
  userId: string,
  projectId: string,
): Promise<boolean> {
  try {
    await assertEvalRole(scope, userId, projectId);
    return true;
  } catch (error) {
    if (error instanceof EvaluationError) return false;
    throw error;
  }
}

/** True when the person may read the project's plans: an admin or any role on the project. */
export async function mayReadPlans(
  scope: TenantScope,
  userId: string,
  projectId: string,
): Promise<boolean> {
  if (await isTenantAdmin(scope, userId)) return true;
  return (await scope.roleBindings.listForUser(userId)).some((b) => b.project_id === projectId);
}

/** The next scheduled time strictly after `after` (UTC); weekday 1 = Monday. */
export function nextScheduledRun(schedule: PlanSchedule, after: Date): Date {
  const next = new Date(
    Date.UTC(after.getUTCFullYear(), after.getUTCMonth(), after.getUTCDate(), schedule.hour),
  );
  if (next <= after) next.setUTCDate(next.getUTCDate() + 1);
  if (schedule.every === 'weekly' && schedule.weekday !== null) {
    const isoDay = ((next.getUTCDay() + 6) % 7) + 1;
    next.setUTCDate(next.getUTCDate() + ((schedule.weekday - isoDay + 7) % 7));
  }
  return next;
}

/** The start of the next UTC month: when a plan paused for its cap may run again. */
export function startOfNextUtcMonth(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
}

/**
 * The SHA-256 of what `on_change` watches (ADR-M82 §2.4): the gateway's model names and, for every
 * agent the plan uses, its key and current version, sorted. Names and versions only.
 */
export async function planFleetSha256(
  scope: TenantScope,
  deps: { readonly models: () => Promise<readonly ModelRef[]> },
  projectId: string,
  configurations: readonly PlanConfiguration[],
): Promise<string> {
  const lines = (await deps.models()).map((m) => `model:${m.model}`);
  const { config } = await loadEffectiveConfig(scope.projectConfigs, projectId);
  const keys = new Set(
    configurations
      .map((c) => c.agent_key ?? config.run.agent_key)
      .filter((key): key is string => key !== null),
  );
  for (const key of keys) {
    const agent = await scope.agents.getByKey(key);
    // ADR-M86 §2.2: the version of each agent, whatever its status.
    lines.push(`agent:${key}@${agent ? agent.version : '-'}`);
  }
  lines.sort();
  return createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
}

/** Whether a change needs the passkey step-up from a dashboard session (ADR-M82 §2.7). */
export function planChangeNeedsStepUp(before: PlanContent | null, after: PlanContent): boolean {
  const automatic = (c: PlanContent | null) => c !== null && c.trigger !== 'once';
  if (automatic(after) && !automatic(before)) return true;
  if (before === null) return false;
  return (
    toMicros(after.budgetPerRunUsd) > toMicros(before.budgetPerRunUsd) ||
    toMicros(after.monthlyCapUsd) > toMicros(before.monthlyCapUsd)
  );
}

async function readPrompt(
  deps: Pick<EvaluationPlanDeps, 'gitHost'>,
  project: Project,
  path: string,
): Promise<{ commit: string; sha256: string }> {
  const ref = projectRepoRef(project);
  if (!ref) throw new EvaluationError('git_host_unavailable', 'the project has no repository');
  try {
    const commit = await deps.gitHost.getBranchHead(ref, project.default_branch);
    const text = await deps.gitHost.getFileAtCommit(ref, path, commit);
    return { commit, sha256: createHash('sha256').update(text, 'utf8').digest('hex') };
  } catch (error) {
    if (error instanceof GitHostError) {
      if (error.code === 'not_found') {
        throw new EvaluationError('prompt_not_found', 'the prompt variant is not on the branch');
      }
      throw new EvaluationError('git_host_unavailable', 'the Git host could not be read');
    }
    throw error;
  }
}

/** Checks a content and reads its prompt variants; the result is ready to store. */
async function buildContent(
  scope: TenantScope,
  deps: EvaluationPlanDeps,
  project: Project,
  input: PlanContentInput,
): Promise<PlanContent> {
  const taskIds = input.taskIds && input.taskIds.length > 0 ? [...input.taskIds] : null;
  const kind = input.taskSetKind ?? 'folder';
  if (kind === 'folder' && deps.taskSet && input.taskSetVersion !== null) {
    const set = await deps.taskSet(input.taskSetVersion);
    if (!set) throw new EvaluationError('task_set_not_found', 'unknown task set version');
    if (taskIds?.some((id) => !set.taskIds.includes(id))) {
      throw new EvaluationError('task_not_found', 'a task is not in the task set');
    }
  }
  const configurations: PlanConfiguration[] = [];
  for (const c of input.configurations) {
    const path = c.promptPath?.trim() ? c.promptPath.trim() : null;
    configurations.push({
      id: c.id,
      agent_key: c.agentKey ?? null,
      model: c.model ?? null,
      provider_type: c.model ? (c.providerType ?? null) : null,
      max_iterations: c.maxIterations,
      max_duration_min: c.maxDurationMin,
      prompt: path === null ? null : { path, ...(await readPrompt(deps, project, path)) },
    });
  }
  const content: PlanContent = {
    dataClass: input.dataClass,
    taskSetKind: kind,
    taskSetVersion: input.taskSetVersion,
    taskIds,
    runsPerTask: input.runsPerTask,
    budgetPerRunUsd: input.budgetPerRunUsd,
    monthlyCapUsd: input.monthlyCapUsd,
    trigger: input.trigger,
    schedule: input.trigger === 'schedule' ? (input.schedule ?? null) : null,
    configurations,
  };
  // The format first (a code, an amount), then what it names: the register and the rules.
  try {
    checkPlanContent(content);
  } catch (error) {
    if (error instanceof DbError) throw new EvaluationError('invalid_input', error.message);
    throw error;
  }
  if (kind === 'project') {
    await checkProjectTaskSet(scope, {
      projectId: project.id,
      dataClass: content.dataClass,
      taskIds,
    });
  }
  if (deps.models) {
    const resolved = await resolveConfigurations(
      scope,
      { models: deps.models },
      project.id,
      configurations,
    );
    await checkEvaluationScope(scope, deps, {
      projectId: project.id,
      dataClass: content.dataClass,
      configurations: resolved,
    });
  } else {
    // Without the gateway (the api): the project, its AI record and the register now; the models
    // when the worker starts a run.
    await checkAgents(scope, project.id, configurations);
    await checkEvaluationScope(scope, deps, {
      projectId: project.id,
      dataClass: content.dataClass,
      configurations: [],
    });
  }
  return content;
}

/**
 * ADR-M86 §2.2 (changes ADR-M82 §2.1): an evaluation may run an agent that is `proposed`,
 * `active` or `suspended`, so a new version is evaluated before it is approved. Never a
 * `quarantined` or `retired` agent. Real runs still need an `active` agent (`checkAgentForRun`).
 */
const EVALUABLE_STATUSES: readonly AgentStatus[] = ['proposed', 'active', 'suspended'];

function isEvaluable(agent: Agent): boolean {
  return EVALUABLE_STATUSES.includes(agent.status);
}

/** Every configuration's agent is in the register, may be evaluated and has a model. */
async function checkAgents(
  scope: TenantScope,
  projectId: string,
  configurations: readonly PlanConfiguration[],
): Promise<void> {
  const { config } = await loadEffectiveConfig(scope.projectConfigs, projectId);
  for (const c of configurations) {
    const key = c.agent_key ?? config.run.agent_key;
    if (key === null)
      throw new EvaluationError('agent_not_found', 'no agent for the configuration');
    const agent = await scope.agents.getByKey(key);
    if (!agent) throw new EvaluationError('agent_not_found', `agent ${key} not found`);
    if (!isEvaluable(agent)) {
      throw new EvaluationError('agent_not_active', `agent ${key} is ${agent.status}`);
    }
    if (c.agent_key !== null && !agent.model_ref) {
      throw new EvaluationError('agent_no_model', `agent ${key} has no model`);
    }
  }
}

/**
 * The configurations as an evaluation runs them: the register's agent (its current version, its
 * model and its tools) or the model with the project's default agent (its version and tools); the
 * gateway's provider type.
 */
export async function resolveConfigurations(
  scope: TenantScope,
  deps: { readonly models: () => Promise<readonly ModelRef[]> },
  projectId: string,
  configurations: readonly PlanConfiguration[],
): Promise<EvaluationConfigurationInput[]> {
  const models = await deps.models();
  const { config } = await loadEffectiveConfig(scope.projectConfigs, projectId);
  const resolved: EvaluationConfigurationInput[] = [];
  for (const c of configurations) {
    const key = c.agent_key ?? config.run.agent_key;
    if (key === null)
      throw new EvaluationError('agent_not_found', 'no agent for the configuration');
    const agent = await scope.agents.getByKey(key);
    if (!agent) throw new EvaluationError('agent_not_found', `agent ${key} not found`);
    if (!isEvaluable(agent)) {
      throw new EvaluationError('agent_not_active', `agent ${key} is ${agent.status}`);
    }
    const modelName = c.agent_key !== null ? agent.model_ref : c.model;
    if (!modelName) throw new EvaluationError('agent_no_model', `agent ${key} has no model`);
    const listed = models.find((m) => m.model === modelName);
    if (!listed || (c.provider_type !== null && listed.providerType !== c.provider_type)) {
      throw new EvaluationError('model_not_allowed', `the model of ${c.id} is not on the gateway`);
    }
    resolved.push({
      id: c.id,
      model: modelName,
      providerType: listed.providerType,
      agentVersion: agent.version,
      maxIterations: c.max_iterations,
      maxDurationMin: c.max_duration_min,
      agentId: agent.id,
      instructions: c.prompt,
      source: c.agent_key !== null ? 'agent' : 'model',
      allowedTools: agent.allowed_tools,
    });
  }
  return resolved;
}

async function projectOf(scope: TenantScope, projectId: string): Promise<Project> {
  const project = await scope.projects.getById(projectId);
  if (!project) throw new EvaluationError('project_not_found', `project ${projectId} not found`);
  if (project.status !== 'active') {
    throw new EvaluationError('project_not_active', `project ${projectId} is not active`);
  }
  return project;
}

async function planOf(scope: TenantScope, planId: string): Promise<EvaluationPlan> {
  const plan = await scope.evaluationPlans.getById(planId);
  if (!plan) throw new EvaluationError('plan_not_found', `plan ${planId} not found`);
  if (plan.status === 'archived') throw new EvaluationError('plan_archived', 'archived');
  return plan;
}

function scheduleState(content: PlanContent, at: Date): Date | null {
  return content.trigger === 'schedule' && content.schedule
    ? nextScheduledRun(content.schedule, at)
    : null;
}

/** Creates a plan (version 1). */
export async function createEvaluationPlan(
  scope: TenantScope,
  deps: EvaluationPlanDeps,
  input: {
    readonly projectId: string;
    readonly code: string;
    readonly content: PlanContentInput;
    readonly userId: string;
  },
): Promise<EvaluationPlan> {
  const project = await projectOf(scope, input.projectId);
  await assertEvalRole(scope, input.userId, project.id);
  const content = await buildContent(scope, deps, project, input.content);
  if (await scope.evaluationPlans.getByCode(project.id, input.code)) {
    throw new EvaluationError('plan_code_taken', `plan ${input.code} exists`);
  }
  // Without the gateway (the api), the worker records what it sees first, without a run.
  const seen =
    content.trigger === 'on_change' && deps.models
      ? await planFleetSha256(scope, { models: deps.models }, project.id, content.configurations)
      : null;
  try {
    return await scope.evaluationPlans.create({
      projectId: project.id,
      code: input.code,
      content,
      createdBy: input.userId,
      nextRunAt: scheduleState(content, now(deps)),
      seenSha256: seen,
    });
  } catch (error) {
    if (error instanceof DbError && error.code === 'conflict') {
      throw new EvaluationError('plan_code_taken', `plan ${input.code} exists`);
    }
    if (error instanceof DbError && error.code === 'invalid_value') {
      throw new EvaluationError('invalid_input', error.message);
    }
    throw error;
  }
}

const FIELDS: readonly (readonly [string, (c: PlanContent) => unknown])[] = [
  ['data_class', (c) => c.dataClass],
  ['task_set_kind', (c) => c.taskSetKind ?? 'folder'],
  ['task_set_version', (c) => c.taskSetVersion],
  ['task_ids', (c) => c.taskIds],
  ['runs_per_task', (c) => c.runsPerTask],
  ['budget_per_run_usd', (c) => toMicros(c.budgetPerRunUsd).toString()],
  ['monthly_cap_usd', (c) => toMicros(c.monthlyCapUsd).toString()],
  ['trigger', (c) => c.trigger],
  ['schedule', (c) => c.schedule],
  ['configurations', (c) => c.configurations],
];

/** The names of the fields that differ between two versions (codes for the audit event). */
export function changedPlanFields(before: PlanContent, after: PlanContent): string[] {
  // Canonical JSON: the database returns JSON objects with their keys in another order.
  const same = (x: unknown, y: unknown) => canonicalJson(x ?? null) === canonicalJson(y ?? null);
  return FIELDS.filter(([, read]) => !same(read(before), read(after))).map(([name]) => name);
}

/** Writes the next version of a plan; refuses a stale `expectedVersion` (`plan_changed`). */
export async function changeEvaluationPlan(
  scope: TenantScope,
  deps: EvaluationPlanDeps,
  input: {
    readonly planId: string;
    readonly expectedVersion: number;
    readonly content: PlanContentInput;
    readonly userId: string;
  },
): Promise<{ readonly plan: EvaluationPlan; readonly changed: readonly string[] }> {
  const plan = await planOf(scope, input.planId);
  await assertEvalRole(scope, input.userId, plan.project_id);
  const project = await projectOf(scope, plan.project_id);
  const before = await scope.evaluationPlans.getVersion(plan.id, plan.current_version);
  if (!before) throw new EvaluationError('plan_not_found', 'no current version');
  const content = await buildContent(scope, deps, project, input.content);
  const at = now(deps);
  const spent = await scope.evaluationPlans.spentSince(plan.id, startOfUtcMonth(at));
  if (toMicros(content.monthlyCapUsd) < toMicros(spent)) {
    throw new EvaluationError('cap_below_spent', 'the monthly cap is below this month spend');
  }
  const changed = changedPlanFields(before, content);
  if (changed.length === 0) return { plan, changed };
  const updated = await scope.evaluationPlans.addVersion({
    planId: plan.id,
    expectedVersion: input.expectedVersion,
    content,
    changedBy: input.userId,
    changedFields: changed,
    nextRunAt: scheduleState(content, at),
  });
  if (!updated) throw new EvaluationError('plan_changed', 'the plan moved on');
  if (content.trigger === 'on_change' && before.trigger !== 'on_change') {
    await scope.evaluationPlans.setSchedule(plan.id, {
      seenSha256: deps.models
        ? await planFleetSha256(scope, { models: deps.models }, project.id, content.configurations)
        : null,
    });
  }
  // A higher cap ends a pause for the cap at once.
  if (
    updated.status === 'paused' &&
    updated.pause_reason === MONTHLY_CAP_USED &&
    toMicros(content.monthlyCapUsd) > toMicros(spent)
  ) {
    await scope.evaluationPlans.resume(plan.id);
  }
  return { plan: (await scope.evaluationPlans.getById(plan.id))!, changed };
}

/** Archives a plan (final). An open evaluation of it goes on until it ends. */
export async function archiveEvaluationPlan(
  scope: TenantScope,
  input: { readonly planId: string; readonly userId: string },
): Promise<EvaluationPlan> {
  const plan = await planOf(scope, input.planId);
  await assertEvalRole(scope, input.userId, plan.project_id);
  const archived = await scope.evaluationPlans.archive(plan.id, input.userId);
  if (!archived) throw new EvaluationError('plan_archived', 'archived');
  return archived;
}

/**
 * Starts one run of a plan: an L04 evaluation with the plan's current version. A person needs a
 * role in `access.eval_roles`; the loop acts as the system. Refused while the plan is paused or
 * has an open evaluation; a used-up monthly cap pauses the plan until the next month.
 */
export async function startEvaluationPlan(
  scope: TenantScope,
  deps: EvaluationPlanDeps,
  input: { readonly planId: string; readonly actor: PlanActor },
): Promise<Evaluation> {
  const plan = await planOf(scope, input.planId);
  if (input.actor.type === 'human') {
    await assertEvalRole(scope, input.actor.userId, plan.project_id);
  }
  if (plan.status === 'paused') throw new EvaluationError('plan_paused', 'paused');
  if (await scope.evaluationPlans.openEvaluationId(plan.id)) {
    throw new EvaluationError('evaluation_open', 'the plan has an open evaluation');
  }
  const project = await projectOf(scope, plan.project_id);
  const version = await scope.evaluationPlans.getVersion(plan.id, plan.current_version);
  if (!version) throw new EvaluationError('plan_not_found', 'no current version');
  const at = now(deps);
  const left =
    toMicros(version.monthlyCapUsd) -
    toMicros(await scope.evaluationPlans.spentSince(plan.id, startOfUtcMonth(at)));
  if (left <= 0n) {
    await scope.evaluationPlans.pause(plan.id, MONTHLY_CAP_USED, startOfNextUtcMonth(at));
    throw new EvaluationError('monthly_cap_used', 'the monthly cap is used up');
  }
  const perRun = toMicros(version.budgetPerRunUsd);
  const budgetUsd = fromMicros(left < perRun ? left : perRun);

  if (!deps.models || !deps.taskSet) {
    throw new Error('startEvaluationPlan needs the gateway and the task sets (the worker)');
  }
  const taskSet = await planTaskSet(scope, deps, project, version);
  // Prompt variants are read again: the run uses the file as it is now, and records it.
  const configurations: PlanConfiguration[] = [];
  for (const c of version.configurations) {
    configurations.push(
      c.prompt === null
        ? c
        : {
            ...c,
            prompt: { path: c.prompt.path, ...(await readPrompt(deps, project, c.prompt.path)) },
          },
    );
  }
  const resolved = await resolveConfigurations(
    scope,
    { models: deps.models },
    project.id,
    configurations,
  );
  const fromPlan: EvaluationFromPlan = {
    id: plan.id,
    version: version.version,
    reason: input.actor.type === 'human' ? 'manual' : input.actor.reason,
  };
  try {
    return await scope.transaction(async (tx) => {
      await checkEvaluationScope(tx, deps, {
        projectId: project.id,
        dataClass: version.dataClass,
        configurations: resolved,
      });
      const evaluation = await tx.evaluations.create({
        projectId: project.id,
        dataClass: version.dataClass,
        configName: null,
        plan: fromPlan,
        ...taskSet,
        configurations: resolved,
        runsPerTask: version.runsPerTask,
        budgetUsd,
        startedBy: input.actor.type === 'human' ? input.actor.userId : null,
        now: at,
      });
      if (version.trigger === 'schedule' && version.schedule) {
        await tx.evaluationPlans.setSchedule(plan.id, {
          nextRunAt: nextScheduledRun(version.schedule, at),
        });
      }
      return evaluation;
    });
  } catch (error) {
    if (error instanceof DbError && error.code === 'conflict') {
      throw new EvaluationError('evaluation_open', 'the plan has an open evaluation');
    }
    if (error instanceof DbError && error.code === 'invalid_value') {
      throw new EvaluationError('invalid_input', error.message);
    }
    throw error;
  }
}

/**
 * The task set an evaluation of a plan runs: a numbered set the server has, or the project's
 * approved tasks read from the default branch now (ADR-M85 §2.10).
 */
async function planTaskSet(
  scope: TenantScope,
  deps: EvaluationPlanDeps,
  project: Project,
  version: PlanContent,
): Promise<
  Pick<
    NewEvaluation,
    'taskSetKind' | 'taskSetVersion' | 'taskSetCommit' | 'taskBaseShas' | 'baseSha' | 'taskIds'
  >
> {
  if (version.taskSetKind === 'project') {
    const set = await readProjectTaskSet(scope, deps.gitHost, {
      project,
      dataClass: version.dataClass,
      taskIds: version.taskIds,
    });
    return {
      taskSetKind: 'project',
      taskSetVersion: null,
      taskSetCommit: set.commit,
      taskBaseShas: set.baseShas,
      baseSha: null,
      taskIds: set.taskIds,
    };
  }
  const set =
    version.taskSetVersion === null ? undefined : await deps.taskSet?.(version.taskSetVersion);
  if (!set) throw new EvaluationError('task_set_not_found', 'unknown task set version');
  return {
    taskSetVersion: set.version,
    baseSha: set.baseSha,
    taskIds: version.taskIds ?? set.taskIds,
  };
}

/**
 * A person's **Run now** (QUESTIONS #476): checks the role, the plan and that no evaluation of it
 * is open, then records the request; the worker's loop starts the run and checks the models and
 * the task set. A request that waits already is not an error.
 */
export async function requestEvaluationPlanRun(
  scope: TenantScope,
  input: { readonly planId: string; readonly userId: string },
): Promise<EvaluationPlan> {
  const plan = await planOf(scope, input.planId);
  await assertEvalRole(scope, input.userId, plan.project_id);
  if (plan.status === 'paused') throw new EvaluationError('plan_paused', 'paused');
  if (await scope.evaluationPlans.openEvaluationId(plan.id)) {
    throw new EvaluationError('evaluation_open', 'the plan has an open evaluation');
  }
  await projectOf(scope, plan.project_id);
  await scope.evaluationPlans.requestRun(plan.id, input.userId);
  return (await scope.evaluationPlans.getById(plan.id))!;
}

/** A plan with its current version, for reading. */
export async function readEvaluationPlan(
  scope: TenantScope,
  planId: string,
): Promise<{ readonly plan: EvaluationPlan; readonly version: PlanVersionView } | undefined> {
  const plan = await scope.evaluationPlans.getById(planId);
  if (!plan) return undefined;
  const version = await scope.evaluationPlans.getVersion(plan.id, plan.current_version);
  return version ? { plan, version } : undefined;
}

export { planVersionView };
