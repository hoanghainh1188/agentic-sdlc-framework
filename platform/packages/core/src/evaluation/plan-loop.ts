// One step of the worker's plan loop for one plan (task L05, design/ADR-M82 §2.4, QUESTIONS
// #472, #476). The loop (`apps/worker/src/evaluation-plan-loop.ts`) calls it for every plan that
// is not archived; all state is on the plan row, so a restart continues where it stopped.
//
// In order:
// 1. a pause for the monthly cap that ended is lifted;
// 2. a person's Run now: the request is taken (cleared) and the evaluation started as that person;
//    a refusal is kept on the plan (`last_refusal`) and in the audit log;
// 3. a schedule that is due starts a run as the system; a schedule missed while the worker was
//    down runs once, and the next time is set from now; an open evaluation waits for the next time;
// 4. `on_change`: the fleet hash (the gateway's models, the plan's agent versions) is compared with
//    the one the plan saw; the first sight records it without a run; a change starts a run.
// Never throws for a refusal of the plan: it returns a code. A database or gateway failure throws,
// and the loop logs it and tries again on its next pass.
import type { EvaluationPlan } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { EvaluationError } from './errors.js';
import {
  nextScheduledRun,
  planFleetSha256,
  startEvaluationPlan,
  type EvaluationPlanDeps,
} from './plans.js';

export type PlanStep =
  | { readonly outcome: 'idle' }
  | { readonly outcome: 'resumed' }
  | { readonly outcome: 'started'; readonly evaluationId: string; readonly reason: string }
  | { readonly outcome: 'refused'; readonly code: string; readonly reason: string }
  | { readonly outcome: 'seen' };

type LoopDeps = EvaluationPlanDeps & {
  readonly models: NonNullable<EvaluationPlanDeps['models']>;
  readonly taskSet: NonNullable<EvaluationPlanDeps['taskSet']>;
};

async function start(
  scope: TenantScope,
  deps: LoopDeps,
  plan: EvaluationPlan,
  actor: Parameters<typeof startEvaluationPlan>[2]['actor'],
): Promise<PlanStep> {
  const reason = actor.type === 'human' ? 'manual' : actor.reason;
  try {
    const evaluation = await startEvaluationPlan(scope, deps, { planId: plan.id, actor });
    return { outcome: 'started', evaluationId: evaluation.id, reason };
  } catch (error) {
    if (!(error instanceof EvaluationError)) throw error;
    // The Git host could not be read: a request stays to be tried again.
    if (error.code === 'git_host_unavailable') throw error;
    return { outcome: 'refused', code: error.code, reason };
  }
}

export async function advanceEvaluationPlan(
  scope: TenantScope,
  deps: LoopDeps,
  planId: string,
): Promise<PlanStep> {
  let plan = await scope.evaluationPlans.getById(planId);
  if (!plan || plan.status === 'archived') return { outcome: 'idle' };
  const now = deps.now ? deps.now() : new Date();

  if (plan.status === 'paused') {
    if (plan.paused_until === null || plan.paused_until > now) return { outcome: 'idle' };
    await scope.evaluationPlans.resume(plan.id);
    return { outcome: 'resumed' };
  }

  if (plan.run_requested_at !== null && plan.run_requested_by !== null) {
    const by = plan.run_requested_by;
    const step = await start(scope, deps, plan, { type: 'human', userId: by });
    await scope.evaluationPlans.clearRequest(plan.id);
    if (step.outcome === 'refused') await scope.evaluationPlans.recordRefusal(plan.id, step.code);
    return step;
  }

  const version = await scope.evaluationPlans.getVersion(plan.id, plan.current_version);
  if (!version) return { outcome: 'idle' };

  if (version.trigger === 'schedule' && version.schedule) {
    if (plan.next_run_at === null || plan.next_run_at > now) return { outcome: 'idle' };
    const step = await start(scope, deps, plan, { type: 'system', reason: 'schedule' });
    // Started: `startEvaluationPlan` set the next time. Otherwise: the next time from now, once.
    if (step.outcome !== 'started') {
      await scope.evaluationPlans.setSchedule(plan.id, {
        nextRunAt: nextScheduledRun(version.schedule, now),
      });
      if (step.outcome === 'refused' && step.code !== 'evaluation_open') {
        await scope.evaluationPlans.recordRefusal(plan.id, step.code);
      }
    }
    return step;
  }

  if (version.trigger === 'on_change') {
    const sha = await planFleetSha256(scope, deps, plan.project_id, version.configurations);
    if (plan.seen_sha256 === null) {
      await scope.evaluationPlans.setSchedule(plan.id, { seenSha256: sha });
      return { outcome: 'seen' };
    }
    if (plan.seen_sha256 === sha) return { outcome: 'idle' };
    const step = await start(scope, deps, plan, { type: 'system', reason: 'on_change' });
    // An open evaluation: the change is seen again on a later pass, and runs then.
    if (step.outcome === 'refused' && step.code === 'evaluation_open') return step;
    plan = (await scope.evaluationPlans.getById(plan.id)) ?? plan;
    await scope.evaluationPlans.setSchedule(plan.id, { seenSha256: sha });
    if (step.outcome === 'refused') await scope.evaluationPlans.recordRefusal(plan.id, step.code);
    return step;
  }
  return { outcome: 'idle' };
}
