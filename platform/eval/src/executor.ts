// One evaluation engine, two places (task L04, design/ADR-M81 §2.1). The tasks, the scoring, the
// statistics and the report are the same code; an executor is the part that depends on where the
// evaluation runs: `LocalExecutor` (Docker CLI, a developer machine) and, in L04 PR 4,
// `ServerExecutor` (the worker and the deployed runner). `buildRunResult` turns what happened into
// one run result, so both places write results of the same shape.
import { diffStats, type RunResult } from './result.js';
import type { EvalConfiguration } from './config.js';
import type { ExecutionPlace, HardwareInfo } from './hardware.js';
import type { Score } from './scoring.js';
import type { EvalTask } from './task.js';

export interface ScoringRequest {
  readonly task: EvalTask;
  /** The base of the run as a patch on the pinned commit. */
  readonly basePatch: string;
  /** The agent's change, recomputed outside the sandbox; empty when it made none. */
  readonly agentPatch: string;
}

export interface EvalExecutor {
  readonly where: ExecutionPlace;
  /** The machine behind the numbers (ADR-M81 §2.1). */
  hardware(): Promise<HardwareInfo>;
  /**
   * Scores one run in a fresh scoring container (ADR-M81 §2.5): install from the base lockfile
   * through the package proxy, detach the proxy, then apply the diff and the hidden tests with no
   * egress. Throws when the packages cannot be installed: that is not the agent's fault, so the
   * run gets no result and can be repeated.
   */
  score(request: ScoringRequest): Promise<Score>;
}

/** What the agent run itself measured: codes and numbers, from the run and its cost records. */
export interface RunMeasures {
  readonly outcome: string;
  readonly status: string;
  readonly stopReason: string | null;
  readonly seconds: number;
  readonly iterations: number;
  readonly modelCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  /** Decimal string, 6 decimals. */
  readonly costUsd: string;
  /** Files the agent changed outside the task's plan (counted, never named). */
  readonly outOfPlanFiles: number;
}

/** One run result from the score and the measures; the executor says where and on what hardware. */
export function buildRunResult(input: {
  readonly taskSet: number;
  readonly task: Pick<EvalTask, 'id'>;
  readonly configuration: Pick<EvalConfiguration, 'id' | 'agentVersion'> & {
    readonly model: { readonly name: string };
  };
  readonly run: number;
  readonly instructionsSha256: string;
  readonly agentPatch: string;
  readonly score: Score;
  readonly measures: RunMeasures;
  readonly where: ExecutionPlace;
  readonly hardware: HardwareInfo;
}): RunResult {
  const { score, measures } = input;
  const stats = diffStats(input.agentPatch);
  return {
    schema: 1,
    task_set: input.taskSet,
    task: input.task.id,
    configuration: input.configuration.id,
    model: input.configuration.model.name,
    agent_version: input.configuration.agentVersion,
    instructions_sha256: input.instructionsSha256,
    run: input.run,
    outcome: measures.outcome,
    status: measures.status,
    stop_reason: measures.stopReason,
    applied: score.applied,
    resolved: score.applied && score.failToPass && score.passToPass,
    fail_to_pass_passed: score.failToPass,
    pass_to_pass_passed: score.passToPass,
    ci_passed: score.ci,
    scope_breach: measures.outOfPlanFiles > 0,
    out_of_plan_files: measures.outOfPlanFiles,
    lint_findings: score.lintFindings,
    diff_files: stats.files,
    diff_lines_added: stats.added,
    diff_lines_removed: stats.removed,
    seconds: measures.seconds,
    iterations: measures.iterations,
    model_calls: measures.modelCalls,
    input_tokens: measures.inputTokens,
    output_tokens: measures.outputTokens,
    cached_input_tokens: measures.cachedInputTokens,
    cost_usd: measures.costUsd,
    where: input.where,
    hardware: input.hardware,
  };
}
