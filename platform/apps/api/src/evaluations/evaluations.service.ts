// Evaluation plans and evaluations for the authenticated caller (task L05, design/ADR-M82).
// - Read: a tenant admin, or anybody with a role on the project. No role → 404.
// - Change: a role in `access.eval_roles` (core checks it). The api has no gateway model list and
//   no task sets (QUESTIONS #476): it checks the role, the format, the register, the prompt files
//   and the project's AI record; **Run now** records a request (202) that the worker's loop
//   starts, with the models and task set checked there.
// Every value is a code, an ID, a number, an amount or a hash.
import {
  archiveEvaluationPlan,
  buildAgentMetrics,
  changeEvaluationPlan,
  CommandError,
  consumeStepUp,
  createEvaluationPlan,
  mayChangePlans,
  mayReadPlans,
  PasskeyError,
  planChangeNeedsStepUp,
  stepUpRequestSha256,
  readEvaluationPlan,
  loadEffectiveConfig,
  requestEvaluationPlanRun,
  type EvaluationPlan,
  type EvaluationPlanDeps,
  type PlanContent,
  type PlanContentInput,
  type Project,
  type StepUpAction,
  type TenantScope,
} from '@sdlc/core';
import type { GitHostAdapter } from '@sdlc/contracts';
import { thresholdsFromConfig } from '@sdlc/eval';
import type { z } from 'zod';

import type { Principal } from '../auth/principal.js';
import { ApiError } from '../errors/api-error.js';
import type { PasskeysService, StepUpAnswer } from '../passkeys/passkeys.service.js';
import { presentAgentMetrics } from '../metrics/present.js';
import { presentEvaluation, presentPlan, presentVersion } from './present.js';
import { buildEvaluationReport } from './report.js';
import type {
  changePlanSchema,
  createPlanSchema,
  listEvaluationsSchema,
  PlanBody,
} from './schemas.js';

/** How many evaluations a plan shows. */
const PLAN_EVALUATIONS = 20;
/** The notice of an ended evaluation lasts this long (QUESTIONS #482). */
const RECENT_DAYS = 7;
const RECENT_LIMIT = 50;
const FINAL_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'stopped_budget',
  'cancelled',
  'failed',
]);

export class EvaluationsService {
  constructor(
    private readonly deps: {
      readonly gitHost?: Pick<GitHostAdapter, 'getBranchHead' | 'getFileAtCommit'>;
      readonly policyFactory: EvaluationPlanDeps['policyFactory'];
      readonly now: () => Date;
      /** The passkey step-up of a dashboard session (U06); undefined without sign-in. */
      readonly passkeys?: PasskeysService;
    },
  ) {}

  /**
   * Runs a write; for a dashboard session that needs the step-up (ADR-M82 §2.7), first checks the
   * passkey answer and uses it in the write's transaction, bound to the action and to the SHA-256
   * of the body as the page sent it (without `step_up`) with `decision` and `target`. A token
   * never needs it.
   */
  private async withStepUp<T>(
    p: Principal,
    need: boolean,
    action: StepUpAction,
    target: string,
    raw: Readonly<Record<string, unknown>>,
    write: (scope: TenantScope) => Promise<T>,
  ): Promise<T> {
    if (p.credential.kind !== 'session' || !need) return write(p.scope);
    const { step_up: answer, ...rest } = raw as { step_up?: StepUpAnswer };
    if (!answer || !this.deps.passkeys) throw new ApiError(403, 'step_up_refused');
    const verified = await this.deps.passkeys.verifyStepUp(p, answer);
    const decision = action.slice('eval_plan.'.length);
    const binding = {
      action,
      decision,
      intentId: null,
      escalationId: null,
      gate: null,
      expectedInputSha256: null,
      requestSha256: stepUpRequestSha256({ ...rest, decision, target }),
    };
    return p.scope.transaction(async (tx) => {
      await consumeStepUp(tx, verified, binding, this.deps.now()).catch((error: unknown) => {
        throw error instanceof PasskeyError ? new ApiError(403, 'step_up_refused') : error;
      });
      return write(tx);
    });
  }

  private planDeps(): EvaluationPlanDeps {
    if (!this.deps.gitHost) throw new ApiError(503, 'git_host_unavailable');
    return {
      policyFactory: this.deps.policyFactory,
      gitHost: this.deps.gitHost,
      now: this.deps.now,
    };
  }

  async listPlans(p: Principal, slug: string): Promise<Record<string, unknown>> {
    const project = await this.readableProject(p, slug);
    const plans = await p.scope.evaluationPlans.listForProject(project.id);
    return {
      can_change: await mayChangePlans(p.scope, p.userId, project.id),
      plans: plans.map((plan) => presentPlan(plan, project)),
    };
  }

  async createPlan(
    p: Principal,
    slug: string,
    body: z.infer<typeof createPlanSchema>,
    raw: Readonly<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    const project = await this.readableProject(p, slug);
    const content = contentOf(body);
    const plan = await this.withStepUp(
      p,
      planChangeNeedsStepUp(null, content as unknown as PlanContent),
      'eval_plan.create',
      slug,
      raw,
      (scope) =>
        createEvaluationPlan(scope, this.planDeps(), {
          projectId: project.id,
          code: body.code,
          content,
          userId: p.userId,
        }),
    );
    return this.showPlan(p, plan.id);
  }

  async showPlan(p: Principal, planId: string): Promise<Record<string, unknown>> {
    const { plan, project } = await this.readablePlan(p, planId);
    const read = await readEvaluationPlan(p.scope, plan.id);
    if (!read) throw new ApiError(404, 'not_found');
    const versions = await p.scope.evaluationPlans.listVersions(plan.id);
    const evaluations = await p.scope.evaluationPlans.evaluations(plan.id, PLAN_EVALUATIONS);
    return {
      ...presentPlan(read.plan, project),
      can_change:
        read.plan.status !== 'archived' && (await mayChangePlans(p.scope, p.userId, project.id)),
      current: presentVersion(read.version),
      versions: versions.map((v) => ({
        version: v.version,
        changed_by: v.changedBy,
        created_at: v.createdAt.toISOString(),
      })),
      evaluations: evaluations.map((e) => presentEvaluation(e)),
    };
  }

  async changePlan(
    p: Principal,
    planId: string,
    body: z.infer<typeof changePlanSchema>,
    raw: Readonly<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    const { plan } = await this.readablePlan(p, planId);
    const content = contentOf(body);
    const before = await p.scope.evaluationPlans.getVersion(plan.id, plan.current_version);
    await this.withStepUp(
      p,
      planChangeNeedsStepUp(before ?? null, content as unknown as PlanContent),
      'eval_plan.change',
      plan.id,
      raw,
      (scope) =>
        changeEvaluationPlan(scope, this.planDeps(), {
          planId,
          expectedVersion: body.expected_version,
          content,
          userId: p.userId,
        }),
    );
    return this.showPlan(p, planId);
  }

  async archivePlan(p: Principal, planId: string): Promise<Record<string, unknown>> {
    await this.readablePlan(p, planId);
    await archiveEvaluationPlan(p.scope, { planId, userId: p.userId });
    return this.showPlan(p, planId);
  }

  async requestRun(
    p: Principal,
    planId: string,
    /** The body as sent (checked by the controller with `runPlanSchema`): `{}` or `step_up`. */
    raw: Readonly<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    const { plan } = await this.readablePlan(p, planId);
    // Run now spends money: a dashboard session always confirms it with a passkey.
    await this.withStepUp(p, true, 'eval_plan.run', plan.id, raw, (scope) =>
      requestEvaluationPlanRun(scope, { planId, userId: p.userId }),
    );
    return this.showPlan(p, planId);
  }

  async listEvaluations(
    p: Principal,
    query: z.infer<typeof listEvaluationsSchema>,
  ): Promise<Record<string, unknown>> {
    let projectId: string | undefined;
    if (query.plan !== undefined) {
      const { plan } = await this.readablePlan(p, query.plan);
      const rows = await p.scope.evaluationPlans.evaluations(plan.id, query.limit);
      return { evaluations: rows.map((e) => presentEvaluation(e)) };
    }
    if (query.project !== undefined) {
      projectId = (await this.readableProject(p, query.project)).id;
    } else if (!(await isAdmin(p.scope, p.userId))) {
      throw new ApiError(400, 'invalid_request', undefined, [
        { path: 'query.project', issue: 'required' },
      ]);
    }
    const rows = await p.scope.evaluations.list({
      ...(projectId === undefined ? {} : { projectId }),
      limit: query.limit,
    });
    return { evaluations: rows.map((e) => presentEvaluation(e)) };
  }

  async showEvaluation(p: Principal, code: string): Promise<Record<string, unknown>> {
    const evaluation = await p.scope.evaluations.getByCode(code);
    if (!evaluation || !(await mayReadPlans(p.scope, p.userId, evaluation.project_id))) {
      throw new ApiError(404, 'not_found');
    }
    return presentEvaluation(evaluation, {
      counts: await p.scope.evaluations.counts(evaluation.id),
      spentUsd: await p.scope.evaluations.spentUsd(evaluation.id),
    });
  }

  /**
   * The report of one evaluation (task L06, ADR-M83 §2.2): summaries, comparisons and
   * recommendations by rules, with the thresholds of the project configuration, and the V13
   * numbers of real runs for the same models when the caller may read them (a role in both
   * `access.cost_read_roles` and `access.metrics_read_roles`, ADR-M79; else `no_role`).
   */
  async report(p: Principal, code: string): Promise<Record<string, unknown>> {
    const evaluation = await p.scope.evaluations.getByCode(code);
    if (!evaluation || !(await mayReadPlans(p.scope, p.userId, evaluation.project_id))) {
      throw new ApiError(404, 'not_found');
    }
    const [{ config }, rows, project, counts, spentUsd] = await Promise.all([
      loadEffectiveConfig(p.scope.projectConfigs, evaluation.project_id),
      p.scope.evaluationRuns.resultsForEvaluation(evaluation.id),
      p.scope.projects.getById(evaluation.project_id),
      p.scope.evaluations.counts(evaluation.id),
      p.scope.evaluations.spentUsd(evaluation.id),
    ]);
    const thresholds = thresholdsFromConfig(config.evaluation.recommendations);
    const models = new Set(rows.map((row) => row.model));
    return {
      evaluation: presentEvaluation(evaluation, { counts, spentUsd }),
      final: FINAL_STATUSES.has(evaluation.status),
      ...buildEvaluationReport(rows, evaluation.task_set_version, thresholds),
      real_runs: project ? await this.realRuns(p, project.slug, models) : null,
    };
  }

  /**
   * Evaluations that ended in the last 7 days in the projects where the caller has a role in
   * `access.eval_roles` (tenant admins: every project): the notice of QUESTIONS #482.
   */
  async recent(p: Principal): Promise<Record<string, unknown>> {
    const projects = await p.scope.projects.list();
    const allowed: string[] = [];
    for (const project of projects) {
      if (await mayChangePlans(p.scope, p.userId, project.id)) allowed.push(project.id);
    }
    const since = new Date(this.deps.now().getTime() - RECENT_DAYS * 24 * 3600 * 1000);
    const rows = await p.scope.evaluations.listEndedSince({
      projectIds: allowed,
      since,
      limit: RECENT_LIMIT,
    });
    const slugs = new Map(projects.map((project) => [project.id, project.slug]));
    return {
      since: since.toISOString(),
      evaluations: rows.map((e) => ({ ...presentEvaluation(e), project: slugs.get(e.project_id) })),
    };
  }

  private async realRuns(
    p: Principal,
    projectSlug: string,
    models: ReadonlySet<string>,
  ): Promise<Record<string, unknown>> {
    try {
      const metrics = await buildAgentMetrics(
        p.scope,
        { userId: p.userId },
        { projectSlug },
        this.deps.now(),
      );
      const body = presentAgentMetrics({
        ...metrics,
        rows: metrics.rows.filter((row) => models.has(row.model)),
      }).metrics as Record<string, unknown>;
      return { available: true, ...body };
    } catch (error) {
      if (error instanceof CommandError && error.code === 'forbidden') {
        return { available: false, reason: 'no_role' };
      }
      throw error;
    }
  }

  private async readableProject(p: Principal, slug: string): Promise<Project> {
    const project = await p.scope.projects.getBySlug(slug);
    if (!project || !(await mayReadPlans(p.scope, p.userId, project.id))) {
      throw new CommandError('project_not_found', `project ${slug} not found`);
    }
    return project;
  }

  private async readablePlan(
    p: Principal,
    planId: string,
  ): Promise<{ readonly plan: EvaluationPlan; readonly project: Project }> {
    const plan = await p.scope.evaluationPlans.getById(planId);
    const project = plan ? await p.scope.projects.getById(plan.project_id) : undefined;
    if (!plan || !project || !(await mayReadPlans(p.scope, p.userId, project.id))) {
      throw new ApiError(404, 'not_found');
    }
    return { plan, project };
  }
}

async function isAdmin(scope: TenantScope, userId: string): Promise<boolean> {
  return scope.tenantRoles.holds(userId, 'tenant_admin');
}

function contentOf(body: PlanBody): PlanContentInput {
  return {
    dataClass: body.data_class,
    taskSetVersion: body.task_set_version,
    taskIds: body.task_ids,
    runsPerTask: body.runs_per_task,
    budgetPerRunUsd: body.budget_per_run_usd,
    monthlyCapUsd: body.monthly_cap_usd,
    trigger: body.trigger,
    schedule: body.schedule,
    configurations: body.configurations.map((c) => ({
      id: c.id,
      agentKey: c.agent_key,
      model: c.model,
      providerType: c.provider_type,
      maxIterations: c.max_iterations,
      maxDurationMin: c.max_duration_min,
      promptPath: c.prompt_path,
    })),
  };
}
