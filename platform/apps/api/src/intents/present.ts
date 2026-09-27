// Response bodies (snake_case, like the database and the codes table). Presenters pick fields
// explicitly, so a new column never leaks into the API by accident.
import type { GateDecisionRow, Intent, Plan, Project, SpecRef } from '@sdlc/core';

export interface IntentBody {
  readonly id: string;
  readonly code: string;
  readonly project: { readonly id: string; readonly slug: string };
  readonly title: string;
  readonly description: string;
  readonly risk_tier: string;
  readonly data_class: string;
  readonly max_autonomy: string;
  readonly budget_usd: string;
  readonly status: string;
  readonly current_gate: string | null;
  readonly issue_number: number | null;
  readonly pr_number: number | null;
  readonly created_by: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export function presentIntent(intent: Intent, project: Pick<Project, 'id' | 'slug'>): IntentBody {
  return {
    id: intent.id,
    code: intent.code,
    project: { id: project.id, slug: project.slug },
    title: intent.title,
    description: intent.description,
    risk_tier: intent.risk_tier,
    data_class: intent.data_class,
    max_autonomy: intent.max_autonomy,
    budget_usd: intent.budget_usd,
    status: intent.status,
    current_gate: intent.current_gate,
    issue_number: intent.issue_number,
    pr_number: intent.pr_number,
    created_by: intent.created_by,
    created_at: intent.created_at.toISOString(),
    updated_at: intent.updated_at.toISOString(),
  };
}

export function presentDecision(row: GateDecisionRow): Record<string, unknown> {
  return {
    id: row.id,
    gate: row.gate,
    decision: row.decision,
    oversight_mode: row.oversight_mode,
    approver_role: row.approver_role,
    actor_type: row.actor_type,
    decided_by: row.decided_by,
    reason_code: row.reason_code,
    reason_ref: row.reason_ref,
    input_sha256: row.input_sha256,
    scope: row.scope,
    expires_at: row.expires_at?.toISOString() ?? null,
    config_hash: row.config_hash,
    source: row.source,
    voids_decision_id: row.voids_decision_id,
    created_at: row.created_at.toISOString(),
  };
}

export function presentSpec(spec: SpecRef | undefined): Record<string, unknown> | null {
  return spec
    ? {
        version: spec.version,
        path: spec.path,
        commit_sha: spec.commit_sha,
        content_sha256: spec.content_sha256,
      }
    : null;
}

export function presentPlan(plan: Plan | undefined): Record<string, unknown> | null {
  return plan
    ? { version: plan.version, plan_sha256: plan.plan_sha256, change_flags: plan.change_flags }
    : null;
}
