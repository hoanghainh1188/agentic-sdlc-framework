// Response bodies of evaluation plans and evaluations (snake_case, fields picked explicitly).
// Codes, IDs, numbers, amounts and hashes; a prompt variant shows its path, commit and SHA-256.
import type { Evaluation, EvaluationCounts, EvaluationPlan, PlanVersionView } from '@sdlc/core';

const iso = (at: Date | null): string | null => (at === null ? null : at.toISOString());

export function presentPlan(
  plan: EvaluationPlan,
  project: { readonly id: string; readonly slug: string },
): Record<string, unknown> {
  return {
    id: plan.id,
    project: { id: project.id, slug: project.slug },
    code: plan.code,
    version: plan.current_version,
    status: plan.status,
    pause_reason: plan.pause_reason,
    paused_until: iso(plan.paused_until),
    next_run_at: iso(plan.next_run_at),
    run_requested_at: iso(plan.run_requested_at),
    last_refusal: plan.last_refusal,
    last_refusal_at: iso(plan.last_refusal_at),
    created_by: plan.created_by,
    created_at: plan.created_at.toISOString(),
    updated_at: plan.updated_at.toISOString(),
  };
}

export function presentVersion(version: PlanVersionView): Record<string, unknown> {
  return {
    version: version.version,
    data_class: version.dataClass,
    task_set_version: version.taskSetVersion,
    task_ids: version.taskIds,
    runs_per_task: version.runsPerTask,
    budget_per_run_usd: version.budgetPerRunUsd,
    monthly_cap_usd: version.monthlyCapUsd,
    trigger: version.trigger,
    schedule: version.schedule,
    configurations: version.configurations.map((c) => ({
      id: c.id,
      agent_key: c.agent_key,
      model: c.model,
      provider_type: c.provider_type,
      max_iterations: c.max_iterations,
      max_duration_min: c.max_duration_min,
      prompt: c.prompt && { path: c.prompt.path, commit: c.prompt.commit, sha256: c.prompt.sha256 },
    })),
    changed_by: version.changedBy,
    created_at: version.createdAt.toISOString(),
  };
}

export function presentEvaluation(
  evaluation: Evaluation,
  extra?: { readonly counts: EvaluationCounts; readonly spentUsd: string },
): Record<string, unknown> {
  return {
    id: evaluation.id,
    code: evaluation.code,
    project_id: evaluation.project_id,
    plan_id: evaluation.plan_id,
    plan_version: evaluation.plan_version,
    config_name: evaluation.config_name,
    data_class: evaluation.data_class,
    task_set_version: evaluation.task_set_version,
    task_ids: evaluation.task_ids,
    configuration_ids: evaluation.configuration_ids,
    runs_per_task: evaluation.runs_per_task,
    budget_usd: String(evaluation.budget_usd),
    status: evaluation.status,
    stop_reason: evaluation.stop_reason,
    started_by: evaluation.started_by,
    created_at: evaluation.created_at.toISOString(),
    finished_at: iso(evaluation.finished_at),
    ...(extra ? { runs: extra.counts, spent_usd: extra.spentUsd } : {}),
  };
}
