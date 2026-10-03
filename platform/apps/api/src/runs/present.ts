// Response bodies of the run endpoints (task C11, ADR-M42 §2.6): IDs, codes, counts and times
// only; never paths, logs or the model's text. The CLI checks them with its own schemas.
import type { KillRunResult, Run } from '@sdlc/core';

export function presentRun(run: Run): Record<string, unknown> {
  return {
    id: run.id,
    attempt: run.attempt,
    status: run.status,
    stop_reason: run.stop_reason,
    agent_version: run.agent_version,
    iterations: run.iterations,
    killed_by: run.killed_by,
    created_at: run.created_at.toISOString(),
    started_at: run.started_at === null ? null : new Date(run.started_at).toISOString(),
    finished_at: run.finished_at === null ? null : new Date(run.finished_at).toISOString(),
  };
}

export function presentRunList(intentCode: string, runs: readonly Run[]): Record<string, unknown> {
  return { intent: intentCode, items: runs.map((run) => presentRun(run)) };
}

export function presentKill(intentCode: string, result: KillRunResult): Record<string, unknown> {
  return {
    run: result.runId,
    intent: intentCode,
    status: result.status,
    already: result.already,
    escalation: result.escalationId ?? null,
  };
}
