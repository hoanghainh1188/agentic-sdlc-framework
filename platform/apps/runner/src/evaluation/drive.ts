// Drives the agent of an evaluation run in its sandbox (task L04, design/ADR-M81 §2.3, §2.8). The
// same agent path as a real run (`driveAgent`, ADR-M29): the Agent Server in the sandbox, the model
// through LiteLLM with the run's capped virtual key, the iteration and time caps, the budget stop,
// loop detection, and "interrupt, then kill". It shares the poll loop and the stop step with
// `driveAgent`, so the numbers describe what the platform runs.
//
// What differs: an evaluation run has no row in `runs` (QUESTIONS #460), so there is no run event,
// no kill switch (the activity's cancel and a real run's need for the slot stop it), no plan or
// spec from the database (the task comes from the task set), no G5 and no feedback. The result is
// returned to the caller, which keeps it in memory; nothing here writes to the database.
import {
  AgentError,
  type AgentAdapter,
  type AgentOutputs,
  type AgentRunHandle,
  type AgentTask,
  type ProjectConfig,
  type RedactedSecret,
  type RunContract,
  type RunKeySpendReader,
} from '@sdlc/contracts';

import { attachRunner } from '../agent/access.js';
import {
  AGENT_WORKING_DIR,
  agentCommitAuthor,
  clockOf,
  llmReachable,
  outcomeOf,
  pollUntilDone,
  sleepOf,
  STATUS_OF,
  STOP_REASON_OF,
  stopAtTimeCap,
  failureCode,
  type AgentOutcome,
  type EndOutcome,
} from '../agent/drive.js';
import { AgentRunError } from '../agent/errors.js';
import { LoopWatch } from '../agent/loop-watch.js';
import { SpendWatch } from '../agent/spend.js';
import type { DockerClient } from '../docker/client.js';
import type { Sandbox } from '../sandbox/lifecycle.js';
import type { RunnerSettings } from '../settings.js';

export interface EvaluationDriveDeps {
  readonly docker: DockerClient;
  readonly settings: RunnerSettings;
  readonly adapter: AgentAdapter;
  /** Reads the spend of the run's key with the key itself. Without it only the gateway's cap holds. */
  readonly spendReader?: RunKeySpendReader;
  /** The project's effective configuration: the budget shares and the loop window. */
  readonly config: Pick<ProjectConfig, 'budget' | 'run'>;
  readonly clock?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Tests only: reach the Agent Server another way than on the run's network. */
  readonly agentUrl?: (runId: string) => string;
}

export interface EvaluationDriveRequest {
  /** The contract view for the adapter (`agentContractOf`). */
  readonly contract: RunContract;
  readonly sandbox: Sandbox;
  readonly model: string;
  readonly virtualKey: RedactedSecret;
  readonly task: AgentTask;
  /** Aborted when the evaluation stops or a real run needs the slot. */
  readonly signal?: AbortSignal;
}

export type EvaluationDriveOutcome = AgentOutcome | 'cancelled';

export interface EvaluationDriveResult {
  readonly outcome: EvaluationDriveOutcome;
  /** The status a run with this outcome would have, as in ADR-M78 (`succeeded`, …); null if none. */
  readonly status: string | null;
  readonly stopReason: string | null;
  /** Iterations the agent made; 0 when unknown. */
  readonly iterations: number;
  /** What the sandbox reported; undefined when the agent could not be reached. Untrusted. */
  readonly outputs: AgentOutputs | undefined;
}

const failed = (reason: string): EvaluationDriveResult => ({
  outcome: 'failed',
  status: 'failed',
  stopReason: reason.startsWith('agent_') ? reason : `agent_${reason}`,
  iterations: 0,
  outputs: undefined,
});

/** Runs the agent to its end. Never throws for an agent or task failure: it returns `failed`. */
export async function driveEvaluationAgent(
  deps: EvaluationDriveDeps,
  request: EvaluationDriveRequest,
): Promise<EvaluationDriveResult> {
  const { contract, sandbox } = request;
  const poll = {
    adapter: deps.adapter,
    settings: deps.settings,
    ...(deps.clock ? { clock: deps.clock } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  };
  let handle: AgentRunHandle;
  let watch: SpendWatch | undefined;
  try {
    if (!llmReachable(contract, deps.settings.agent.llmBaseUrl)) {
      throw new AgentRunError('model_unreachable');
    }
    if (deps.spendReader) {
      watch = new SpendWatch({
        reader: deps.spendReader,
        key: request.virtualKey,
        contractCapUsd: contract.max_budget_usd,
        limits: {
          warnPercent: deps.config.budget.warn_percent,
          stopPercent: deps.config.budget.stop_percent,
        },
        // No intent to warn: the evaluation's own budget is watched by the worker.
        onWarning: () => Promise.resolve(),
      });
    }
    const endpoint = await attachRunner(
      deps.docker,
      deps.settings,
      sandbox,
      deps.agentUrl?.(contract.run_id),
    );
    handle = await deps.adapter.startRun({
      contract,
      endpoint,
      model: {
        model: request.model,
        baseUrl: deps.settings.agent.llmBaseUrl,
        virtualKey: request.virtualKey,
      },
      task: request.task,
      workingDir: AGENT_WORKING_DIR,
    });
  } catch (error) {
    return failed(failureCode(error));
  }

  const clock = clockOf(poll);
  const deadline = clock() + contract.max_duration_min * 60_000;
  const loops = new LoopWatch(
    {
      identicalCallsMax: contract.loop_threshold,
      noProgressWindowMs: deps.config.run.loop_detection.no_progress_window_minutes * 60_000,
    },
    clock,
  );
  let polled;
  try {
    polled = await pollUntilDone(poll, handle, deadline, request.signal, watch, undefined, loops);
  } catch (error) {
    return failed(failureCode(error));
  }
  if (polled.cancelled) {
    await stopAtTimeCap(poll, handle);
    return {
      outcome: 'cancelled',
      status: null,
      stopReason: null,
      iterations: polled.iterations,
      outputs: undefined,
    };
  }

  let outcome: AgentOutcome;
  let iterations: number = polled.iterations;
  let reachable = true;
  if (polled.timedOut || polled.overBudget || polled.loop) {
    outcome = polled.overBudget ? 'max_budget' : (polled.loop?.reason ?? 'max_duration');
    const stopped = await stopAtTimeCap(poll, handle);
    iterations = stopped.iterations ?? iterations;
    reachable = stopped.method === 'interrupt';
  } else {
    outcome = outcomeOf(polled.state, polled.iterations, contract.max_iterations);
    // The gateway refuses calls past the key's cap and records spend late (ADR-M34 §2.6).
    if (
      outcome === 'agent_error' &&
      watch &&
      (await watch.settleAfterError(sleepOf(poll), deps.settings.agent.spendRecheckMs))
    ) {
      outcome = 'max_budget';
    }
  }

  let outputs: AgentOutputs | undefined;
  if (reachable) {
    try {
      if (outcome === 'finished') {
        await deps.adapter.commitWork(handle, {
          branch: contract.branch,
          author: agentCommitAuthor(contract),
          message: `sdlc: evaluation run ${contract.run_id}`,
        });
      }
      outputs = await deps.adapter.collectOutputs(handle, contract.base_sha);
      iterations = outputs.iterations;
    } catch (error) {
      if (error instanceof AgentError || error instanceof AgentRunError) {
        return failed(failureCode(error));
      }
      return failed('runner_error');
    }
  }
  const end = outcome as EndOutcome;
  return {
    outcome,
    status: STATUS_OF[end],
    stopReason: STOP_REASON_OF[end] ?? null,
    iterations,
    outputs,
  };
}
