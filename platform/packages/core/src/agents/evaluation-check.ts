// Evaluations as evidence in the agent register (task L09, design/ADR-M86 §2.3–§2.5, §2.8;
// QUESTIONS #496–#504).
//
// - The agent's projects (QUESTIONS #504): the active projects whose effective `run.agent_key` is
//   the agent. `agents.evaluation.mode` is the strictest of theirs (`required` > `warn` > `off`);
//   with none, the default configuration. A named evaluation belongs to one of them (any project
//   of the tenant when the agent has none); its thresholds come from the evaluation's project.
// - The fingerprint (ADR-M86 §2.1, QUESTIONS #502): a configuration of the evaluation with the
//   agent's model and `tools_sha256`, and every scored run of it read instructions with the
//   agent's `instructions_sha256`. That configuration is the candidate.
// - The conditions of §2.3 are checked in their order; the first that fails is the result, with
//   the numbers its catalog text quotes. Numbers and codes only; the fingerprint is compared here
//   and never written to the audit log (ADR-M86 §2.7).
import { defaultProjectConfig } from '@sdlc/config';
import type { AgentEvaluationMode, ValidatedProjectConfig } from '@sdlc/contracts';
import { buildReport, differs, type ConfigurationSummary } from '@sdlc/eval';

import type { Agent, Evaluation, EvaluationConfigurationRow } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { toRunResult, type StoredResult } from '../evaluation/report-rows.js';
import { loadEffectiveConfig } from '../registry/effective-config.js';
import { toolsSha256 } from './fingerprint.js';

/** The refusal codes of ADR-M86 §2.8. `evaluation_quality_dropped` is used by L10. */
export const AGENT_EVALUATION_REFUSALS = [
  'evaluation_missing',
  'evaluation_not_found',
  'evaluation_not_completed',
  'evaluation_other_project',
  'evaluation_not_matching',
  'evaluation_task_set_partial',
  'evaluation_too_few_tasks',
  'evaluation_below_threshold',
  'evaluation_scope_breach',
  'evaluation_no_baseline',
  'evaluation_worse_than_baseline',
  'evaluation_too_old',
  'evaluation_not_latest',
  'evaluation_round_mismatch',
  'evaluation_quality_dropped',
] as const;
export type AgentEvaluationRefusal = (typeof AGENT_EVALUATION_REFUSALS)[number];

/** What `agent_approvals.evaluation_result` records: `missing` is the code of no evaluation. */
export type AgentEvaluationResult = 'passed' | 'missing' | AgentEvaluationRefusal;

export interface AgentEvaluationVerdict {
  readonly mode: AgentEvaluationMode;
  /** The named evaluation, when it exists in the tenant. */
  readonly evaluation: Evaluation | null;
  /** Null when the mode is `off`: nothing was checked. */
  readonly result: AgentEvaluationResult | null;
  /** The numbers the catalog text quotes (decimal strings and counts as strings). */
  readonly params: Readonly<Record<string, string>>;
  /**
   * A recertification (L10, ADR-M86 §2.6): the comparison with the evaluation of the agent's last
   * activation. Null for an approval, or when an earlier condition failed.
   */
  readonly aging?: AgentEvaluationAging | null;
}

/**
 * The aging comparison (ADR-M86 §2.6). `skipped`: with `no_activation_evaluation` (QUESTIONS
 * #506) or `too_few_shared_tasks`; `compared`: no significant drop was found.
 */
export interface AgentEvaluationAging {
  readonly status: 'compared' | 'skipped';
  readonly reason: 'no_activation_evaluation' | 'too_few_shared_tasks' | null;
  readonly params: Readonly<Record<string, string>>;
}

/** A configuration that has the version's fingerprint, and its scored runs. */
interface Candidate {
  readonly configuration: EvaluationConfigurationRow;
  readonly rows: readonly StoredResult[];
}

/** How many evaluations ended after the named one are read to find a later one (bounded). */
const LATEST_WINDOW = 50;
const DAY_MS = 86_400_000;
const STRICTNESS: readonly AgentEvaluationMode[] = ['off', 'warn', 'required'];

const rate = (value: number): string => value.toFixed(3);

/** The active projects whose effective `run.agent_key` is the agent (QUESTIONS #504). */
export async function agentProjects(
  scope: TenantScope,
  agentKey: string,
): Promise<{ readonly projectId: string; readonly config: ValidatedProjectConfig }[]> {
  const found: { projectId: string; config: ValidatedProjectConfig }[] = [];
  for (const project of await scope.projects.list()) {
    if (project.status !== 'active') continue;
    const { config } = await loadEffectiveConfig(scope.projectConfigs, project.id);
    if (config.run.agent_key === agentKey) found.push({ projectId: project.id, config });
  }
  return found;
}

/** The strictest mode of the agent's projects; the default configuration's without one. */
export function strictestMode(configs: readonly ValidatedProjectConfig[]): AgentEvaluationMode {
  if (configs.length === 0) return defaultProjectConfig().agents.evaluation.mode;
  return configs
    .map((config) => config.agents.evaluation.mode)
    .reduce((a, b) => (STRICTNESS.indexOf(a) >= STRICTNESS.indexOf(b) ? a : b));
}

/** The configuration of the evaluation with the agent's fingerprint, if any (§2.1, #502). */
async function candidateOf(
  scope: TenantScope,
  evaluationId: string,
  agent: Agent,
): Promise<{ candidate: Candidate | null; rows: readonly StoredResult[] }> {
  const [configurations, rows] = await Promise.all([
    scope.evaluations.configurations(evaluationId),
    scope.evaluationRuns.resultsForEvaluation(evaluationId),
  ]);
  const tools = toolsSha256(agent.allowed_tools);
  for (const configuration of configurations) {
    if (configuration.tools_sha256 !== tools || configuration.model !== agent.model_ref) continue;
    const own = rows.filter((row) => row.configuration_id === configuration.configuration_id);
    if (own.length > 0 && own.every((r) => r.instructions_sha256 === agent.instructions_sha256)) {
      return { candidate: { configuration, rows: own }, rows };
    }
  }
  return { candidate: null, rows };
}

/**
 * The evaluation used the project's whole task set when it started (ADR-M85 §2.10): a plan that
 * named no task IDs. A numbered set counts only while the project had no approved task
 * (QUESTIONS #498, #503).
 */
async function usedWholeTaskSet(scope: TenantScope, evaluation: Evaluation): Promise<boolean> {
  if (evaluation.plan_id === null || evaluation.plan_version === null) return false;
  if (evaluation.approved_tasks_at_start === null) return false;
  const version = await scope.evaluationPlans.getVersion(
    evaluation.plan_id,
    evaluation.plan_version,
  );
  if (!version || version.taskIds !== null) return false;
  return evaluation.task_set_kind === 'project' || evaluation.approved_tasks_at_start === 0;
}

/**
 * The agent's last completed activation round (ADR-M86 §2.5, §2.6): the latest round of
 * `activate` approvals in two different capacities (every approver set of the MVP has two), with
 * its version and the evaluation its approvals named, if any.
 */
export async function lastActivation(
  scope: TenantScope,
  agentId: string,
): Promise<{ readonly version: string; readonly evaluationId: string | null } | null> {
  const rounds = new Map<
    number,
    { version: string; evaluationId: string | null; capacities: Set<string> }
  >();
  for (const approval of await scope.agentApprovals.listForAgent(agentId, 'activate')) {
    const key = approval.round_at.getTime();
    const round = rounds.get(key) ?? {
      version: approval.agent_version,
      evaluationId: null,
      capacities: new Set<string>(),
    };
    round.capacities.add(approval.capacity);
    round.evaluationId ??= approval.evaluation_id;
    rounds.set(key, round);
  }
  const completed = [...rounds.entries()]
    .filter(([, round]) => round.capacities.size >= 2)
    .sort(([a], [b]) => b - a);
  const last = completed[0]?.[1];
  return last ? { version: last.version, evaluationId: last.evaluationId } : null;
}

/** The version of the agent's last completed activation round (ADR-M86 §2.5). */
export async function lastActivatedVersion(
  scope: TenantScope,
  agentId: string,
): Promise<string | null> {
  return (await lastActivation(scope, agentId))?.version ?? null;
}

function summaries(
  rows: readonly StoredResult[],
  evaluation: Evaluation,
  alpha: number,
): ReturnType<typeof buildReport> {
  const taskSet = evaluation.task_set_version ?? 0;
  return buildReport(
    rows.map((row) => toRunResult(row, taskSet)),
    taskSet,
    [],
    1,
    alpha,
  );
}

export interface CheckAgentEvaluation {
  readonly agent: Agent;
  /** `EVAL-YYYY-NNNN`, or null when the approval names none. */
  readonly evaluationCode: string | null;
  /** Which age limit applies: an approval (§2.5) or a recertification (§2.6, L10). */
  readonly purpose: 'approval' | 'recertification';
  /** A change (§20.11): the candidate must not be worse than the last approved version. */
  readonly change: boolean;
  readonly now: Date;
}

/** Checks an evaluation for the agent as it is now (ADR-M86 §2.3). Never throws a refusal. */
export async function checkAgentEvaluation(
  scope: TenantScope,
  input: CheckAgentEvaluation,
): Promise<AgentEvaluationVerdict> {
  const { agent } = input;
  const projects = await agentProjects(scope, agent.agent_key);
  const mode = strictestMode(projects.map((p) => p.config));
  const verdict = (
    evaluation: Evaluation | null,
    result: AgentEvaluationResult,
    params: Record<string, string> = {},
  ): AgentEvaluationVerdict => ({
    mode,
    evaluation,
    result,
    params: { key: agent.agent_key, code: evaluation?.code ?? '-', ...params },
  });
  if (mode === 'off') return { mode, evaluation: null, result: null, params: {} };
  if (input.evaluationCode === null) return verdict(null, 'missing');

  const evaluation = (await scope.evaluations.getByCode(input.evaluationCode)) ?? null;
  if (!evaluation) {
    return { ...verdict(null, 'evaluation_not_found'), params: { code: input.evaluationCode } };
  }
  if (evaluation.status !== 'completed' || evaluation.finished_at === null) {
    return verdict(evaluation, 'evaluation_not_completed', { status: evaluation.status });
  }
  if (projects.length > 0 && !projects.some((p) => p.projectId === evaluation.project_id)) {
    return verdict(evaluation, 'evaluation_other_project');
  }
  const { config } = await loadEffectiveConfig(scope.projectConfigs, evaluation.project_id);
  const thresholds = config.agents.evaluation;
  const alpha = config.evaluation.recommendations.alpha;

  const { candidate, rows } = await candidateOf(scope, evaluation.id, agent);
  if (!candidate) return verdict(evaluation, 'evaluation_not_matching');
  const candidateId = candidate.configuration.configuration_id;
  if (!(await usedWholeTaskSet(scope, evaluation))) {
    return verdict(evaluation, 'evaluation_task_set_partial');
  }
  const tasks = new Set(candidate.rows.map((row) => row.task_id)).size;
  if (tasks < thresholds.min_tasks) {
    return verdict(evaluation, 'evaluation_too_few_tasks', {
      tasks: String(tasks),
      min: String(thresholds.min_tasks),
    });
  }
  const own = summaries(candidate.rows, evaluation, alpha).configurations[0]!;
  if (own.resolved.estimate < thresholds.min_resolve_rate) {
    return verdict(evaluation, 'evaluation_below_threshold', {
      rate: rate(own.resolved.estimate),
      low: rate(own.resolved.low),
      high: rate(own.resolved.high),
      min: rate(thresholds.min_resolve_rate),
    });
  }
  // A safety rule, fixed in code (handbook Ch.20 §20.6).
  if (own.scopeBreaches > 0) {
    return verdict(evaluation, 'evaluation_scope_breach', { breaches: String(own.scopeBreaches) });
  }
  // A change (§20.11): not worse than the last approved version in the same evaluation.
  if (input.change) {
    const worse = await worseThanBaseline(scope, {
      agent,
      evaluation,
      rows,
      candidateId,
      candidate: own,
      minTasks: thresholds.min_tasks,
      alpha,
    });
    if (worse) return verdict(evaluation, worse.result, worse.params);
  }
  const maxDays =
    input.purpose === 'approval'
      ? thresholds.approval_max_age_days
      : thresholds.recertification_max_age_days;
  const days = Math.floor((input.now.getTime() - evaluation.finished_at.getTime()) / DAY_MS);
  if (days > maxDays) {
    return verdict(evaluation, 'evaluation_too_old', { days: String(days), max: String(maxDays) });
  }
  const later = await scope.evaluations.listCompleted({
    projectId: evaluation.project_id,
    after: evaluation.finished_at,
    limit: LATEST_WINDOW,
  });
  for (const other of later) {
    // PostgreSQL keeps microseconds, a Date milliseconds: the evaluation itself may come back.
    if (other.id === evaluation.id) continue;
    if ((await candidateOf(scope, other.id, agent)).candidate) {
      return verdict(evaluation, 'evaluation_not_latest', { latest: other.code });
    }
  }
  const passed = {
    rate: rate(own.resolved.estimate),
    low: rate(own.resolved.low),
    high: rate(own.resolved.high),
    tasks: String(tasks),
  };
  if (input.purpose !== 'recertification') return verdict(evaluation, 'passed', passed);
  // Aging (§2.6): compared with the evaluation of the last activation, on the shared tasks.
  const aging = await agingOf(scope, {
    agent,
    rows: candidate.rows,
    minTasks: thresholds.min_tasks,
    alpha,
  });
  if (aging.dropped) {
    return { ...verdict(evaluation, 'evaluation_quality_dropped', aging.params), aging: null };
  }
  return { ...verdict(evaluation, 'passed', passed), aging: aging.aging };
}

/** The candidate's rows under one configuration ID, so two evaluations can be paired by task. */
const relabel = (rows: readonly StoredResult[], configuration: string): StoredResult[] =>
  rows.map((row) => ({ ...row, configuration_id: configuration }));

/**
 * The aging comparison of a recertification (ADR-M86 §2.6): the candidate now and in the
 * evaluation of the last activation, on the tasks both share, with the one test of ADR-M83 §2.3.
 * A significant drop is a fact for people: the platform never suspends the agent (§20.9).
 */
async function agingOf(
  scope: TenantScope,
  input: {
    readonly agent: Agent;
    readonly rows: readonly StoredResult[];
    readonly minTasks: number;
    readonly alpha: number;
  },
): Promise<
  | { dropped: true; params: Record<string, string> }
  | { dropped: false; aging: AgentEvaluationAging }
> {
  const skipped = (
    reason: NonNullable<AgentEvaluationAging['reason']>,
    params: Record<string, string> = {},
  ) => ({ dropped: false as const, aging: { status: 'skipped' as const, reason, params } });
  const activation = await lastActivation(scope, input.agent.id);
  const before = activation?.evaluationId
    ? await scope.evaluations.getById(activation.evaluationId)
    : undefined;
  const then = before ? (await candidateOf(scope, before.id, input.agent)).candidate : null;
  if (!before || !then) return skipped('no_activation_evaluation');
  const shared = new Set(then.rows.map((row) => row.task_id));
  const now = input.rows.filter((row) => shared.has(row.task_id));
  const report = buildReport(
    [...relabel(then.rows, 'before'), ...relabel(now, 'now')].map((row) => toRunResult(row, 0)),
    0,
    [],
    1,
    input.alpha,
  );
  const comparison = report.comparisons[0];
  const sharedTasks = comparison?.pairedTasks ?? 0;
  const was = report.configurations.find((c) => c.configuration === 'before');
  const is = report.configurations.find((c) => c.configuration === 'now');
  if (!comparison || !was || !is || sharedTasks < input.minTasks) {
    return skipped('too_few_shared_tasks', {
      before: before.code,
      shared: String(sharedTasks),
      min: String(input.minTasks),
    });
  }
  const params = {
    before: before.code,
    shared: String(sharedTasks),
    rate: rate(is.resolved.estimate),
    before_rate: rate(was.resolved.estimate),
    p_value: String(comparison.pValue),
  };
  const dropped =
    differs(is.resolved, was.resolved, comparison.pValue, input.alpha) &&
    is.resolved.estimate < was.resolved.estimate;
  return dropped
    ? { dropped: true, params }
    : { dropped: false, aging: { status: 'compared', reason: null, params } };
}

/** `evaluation_no_baseline`, `evaluation_too_few_tasks` (paired) or `…_worse_than_baseline`. */
async function worseThanBaseline(
  scope: TenantScope,
  input: {
    readonly agent: Agent;
    readonly evaluation: Evaluation;
    readonly rows: readonly StoredResult[];
    readonly candidateId: string;
    readonly candidate: ConfigurationSummary;
    readonly minTasks: number;
    readonly alpha: number;
  },
): Promise<{ result: AgentEvaluationRefusal; params: Record<string, string> } | null> {
  const version = await lastActivatedVersion(scope, input.agent.id);
  const baseline =
    version === null
      ? undefined
      : (await scope.evaluations.configurations(input.evaluation.id)).find(
          (c) =>
            c.source === 'agent' &&
            c.agent_id === input.agent.id &&
            c.agent_version === version &&
            c.configuration_id !== input.candidateId,
        );
  if (!baseline) return { result: 'evaluation_no_baseline', params: { version: version ?? '-' } };
  const report = summaries(
    input.rows.filter(
      (row) =>
        row.configuration_id === input.candidateId ||
        row.configuration_id === baseline.configuration_id,
    ),
    input.evaluation,
    input.alpha,
  );
  const base = report.configurations.find((c) => c.configuration === baseline.configuration_id);
  const comparison = report.comparisons[0];
  if (!base || !comparison || comparison.pairedTasks < input.minTasks) {
    return {
      result: 'evaluation_too_few_tasks',
      params: { tasks: String(comparison?.pairedTasks ?? 0), min: String(input.minTasks) },
    };
  }
  const worse =
    differs(input.candidate.resolved, base.resolved, comparison.pValue, input.alpha) &&
    input.candidate.resolved.estimate < base.resolved.estimate;
  if (!worse) return null;
  return {
    result: 'evaluation_worse_than_baseline',
    params: {
      rate: rate(input.candidate.resolved.estimate),
      baseline_rate: rate(base.resolved.estimate),
      p_value: String(comparison.pValue),
      paired: String(comparison.pairedTasks),
      version: baseline.agent_version,
    },
  };
}

/**
 * The latest completed evaluation with the agent's current fingerprint in its projects (any
 * active project when it has none), and its verdict for an approval (`sdlc admin agent show`) or a
 * recertification (`list --overdue`, L10).
 */
export async function latestAgentEvaluation(
  scope: TenantScope,
  agent: Agent,
  now: Date,
  purpose: CheckAgentEvaluation['purpose'] = 'approval',
): Promise<AgentEvaluationVerdict | null> {
  const own = await agentProjects(scope, agent.agent_key);
  const projectIds =
    own.length > 0
      ? own.map((p) => p.projectId)
      : (await scope.projects.list()).filter((p) => p.status === 'active').map((p) => p.id);
  let latest: Evaluation | null = null;
  for (const projectId of projectIds) {
    for (const evaluation of await scope.evaluations.listCompleted({
      projectId,
      limit: LATEST_WINDOW,
    })) {
      if (latest && evaluation.finished_at! <= latest.finished_at!) break;
      if ((await candidateOf(scope, evaluation.id, agent)).candidate) {
        latest = evaluation;
        break;
      }
    }
  }
  if (!latest) return null;
  return checkAgentEvaluation(scope, {
    agent,
    evaluationCode: latest.code,
    purpose,
    // An active agent has no next version yet: its evaluation is shown as for a first use.
    change:
      purpose === 'approval' && (agent.status === 'suspended' || agent.status === 'quarantined'),
    now,
  });
}
