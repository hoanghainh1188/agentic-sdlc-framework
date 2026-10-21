// Stored evaluation results as run results of the engine (task L06, moved to core by L09 so the
// report of an evaluation and the agent register's check compute the same numbers; ADR-M83 §2.2,
// ADR-M86 §2.3). Numbers and codes only.
import type { RunResult } from '@sdlc/eval';

/** One stored result with the codes of its run (`evaluationRuns.resultsForEvaluation`). */
export interface StoredResult {
  readonly configuration_id: string;
  readonly task_id: string;
  readonly run_index: number;
  readonly model: string;
  readonly agent_version: string;
  readonly instructions_sha256: string;
  readonly outcome: string;
  readonly status: string;
  readonly stop_reason: string | null;
  readonly applied: boolean;
  readonly resolved: boolean;
  readonly fail_to_pass_passed: boolean;
  readonly pass_to_pass_passed: boolean;
  readonly ci_passed: boolean;
  readonly scope_breach: boolean;
  readonly out_of_plan_files: number;
  readonly lint_findings: number;
  readonly diff_files: number;
  readonly diff_lines_added: number;
  readonly diff_lines_removed: number;
  readonly seconds: number;
  readonly iterations: number;
  readonly model_calls: number;
  readonly input_tokens: string | number;
  readonly output_tokens: string | number;
  readonly cached_input_tokens: string | number;
  readonly cost_usd: string;
  readonly hw_cpu_model: string;
  readonly hw_cpu_cores: number;
  readonly hw_memory_gb: number;
  readonly hw_docker_version: string;
  readonly hw_gpu: string | null;
  readonly hw_runner_instance: string | null;
}

/** A stored result as a run result of the engine (the place is always the server). */
export function toRunResult(row: StoredResult, taskSet: number): RunResult {
  return {
    schema: 1,
    task_set: taskSet,
    task: row.task_id,
    configuration: row.configuration_id,
    model: row.model,
    agent_version: row.agent_version,
    instructions_sha256: row.instructions_sha256,
    run: row.run_index,
    outcome: row.outcome,
    status: row.status,
    stop_reason: row.stop_reason,
    applied: row.applied,
    resolved: row.resolved,
    fail_to_pass_passed: row.fail_to_pass_passed,
    pass_to_pass_passed: row.pass_to_pass_passed,
    ci_passed: row.ci_passed,
    scope_breach: row.scope_breach,
    out_of_plan_files: row.out_of_plan_files,
    lint_findings: row.lint_findings,
    diff_files: row.diff_files,
    diff_lines_added: row.diff_lines_added,
    diff_lines_removed: row.diff_lines_removed,
    seconds: row.seconds,
    iterations: row.iterations,
    model_calls: row.model_calls,
    input_tokens: Number(row.input_tokens),
    output_tokens: Number(row.output_tokens),
    cached_input_tokens: Number(row.cached_input_tokens),
    cost_usd: normaliseUsd(row.cost_usd),
    where: 'server',
    hardware: {
      cpu_model: row.hw_cpu_model,
      cpu_cores: row.hw_cpu_cores,
      memory_gb: row.hw_memory_gb,
      docker_version: row.hw_docker_version,
      gpu: row.hw_gpu,
      runner_instance: row.hw_runner_instance,
    },
  };
}

/** `numeric(18,6)` as six decimals (`0.01` → `0.010000`). */
function normaliseUsd(value: string): string {
  const [whole = '0', fraction = ''] = value.split('.');
  return `${whole}.${(fraction + '000000').slice(0, 6)}`;
}
