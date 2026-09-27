// Drives the agent of one run in its sandbox (D-08 C05 AC1–AC4, ADR-M29). Order:
//
// 1. the run must be `running` (provisioned by `provisionRun`);
// 2. LiteLLM must be on the contract's egress list (the agent reaches models only there, FR-50);
// 3. load the task: the contract's plan and the intent's spec (AC2);
// 4. join the run's network and start the agent with the contract's caps  → `agent_started`;
// 5. poll the agent. The iteration cap is the agent's own (`max_iterations`); the time cap is the
//    runner's: at `max_duration_min` it interrupts the agent, waits the grace period, and otherwise
//    leaves the sandbox to be removed (interrupt, then kill; AC3)          → `agent_stopped`;
// 6. when the agent finished: commit what it left, with the fixed agent author (QUESTIONS #80);
// 7. collect the changed files since `base_sha`, the last commit and the log (AC4);
// 8. end the run with its status, `stop_reason`, `head_sha` and `iterations` → `agent_finished`.
//
// The run leaves `running` only with one conditional update: if the kill switch (C11) or the
// sweep moved it first, this driver changes nothing. The caller removes the sandbox (`Runner`).
// Paths, the log and texts are returned to the caller only; run events hold codes and counts.
import {
  AgentError,
  type AgentAdapter,
  type AgentOutputs,
  type AgentRunHandle,
  type AgentRunState,
  type RedactedSecret,
  type RunContract,
  type RunStatus,
} from '@sdlc/contracts';
import { parseTenantId, type PlatformDatabase, type TenantScope } from '@sdlc/core';

import type { DockerClient } from '../docker/client.js';
import type { Sandbox } from '../sandbox/lifecycle.js';
import type { RunnerSettings } from '../settings.js';
import { attachRunner } from './access.js';
import { AgentRunError } from './errors.js';
import { loadAgentTask } from './task.js';

/** The repository inside the sandbox (ADR-M25 §2.3). */
export const AGENT_WORKING_DIR = '/workspace';

/** Consecutive failed status calls before the runner gives up on the agent. */
const MAX_STATUS_ERRORS = 5;

export interface AgentDriveDeps {
  readonly db: PlatformDatabase;
  readonly docker: DockerClient;
  readonly settings: RunnerSettings;
  readonly adapter: AgentAdapter;
  /** Default: `new Date()`. Stored times. */
  readonly now?: () => Date;
  /** Default: `Date.now`. Deadlines. */
  readonly clock?: () => number;
  /** Default: `setTimeout`. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Default: the sandbox name on the run's network. Tests reach the Agent Server another way. */
  readonly agentUrl?: (runId: string) => string;
}

export interface AgentRunRequest {
  readonly contract: RunContract;
  readonly sandbox: Sandbox;
  /** Model chosen by the caller (the agent's pinned model, QUESTIONS #79). */
  readonly model: string;
  /** The run's LiteLLM virtual key (Cost Controller `issueRunKey`). */
  readonly virtualKey: RedactedSecret;
}

/** How the agent run ended (run event `agent_finished`). */
export type AgentOutcome =
  'finished' | 'max_iterations' | 'max_duration' | 'stuck' | 'agent_error' | 'failed';

export interface AgentRunResult {
  readonly outcome: AgentOutcome;
  /** The run status this driver set, or undefined when the run had already left `running`. */
  readonly status: RunStatus | undefined;
  readonly stopReason: string | undefined;
  /** Undefined when the agent could not be reached any more (killed at the time cap, failures). */
  readonly outputs: AgentOutputs | undefined;
}

/** The fixed author of the platform's commit: it names the agent (G7 producer, FR-11, #80). */
export function agentCommitAuthor(contract: RunContract): { name: string; email: string } {
  return { name: 'sdlc-agent', email: `agent-${contract.agent_id}@agents.sdlc.invalid` };
}

const STATUS_OF: Readonly<Record<Exclude<AgentOutcome, 'failed'>, RunStatus>> = {
  finished: 'succeeded',
  // An iteration cap is a budget of agent steps (D-07 §6: "token cap and a maximum number of
  // iterations"); the stop reason tells which cap (ADR-M29).
  max_iterations: 'stopped_budget',
  max_duration: 'stopped_timeout',
  stuck: 'stopped_stalled',
  agent_error: 'failed',
};

const STOP_REASON_OF: Readonly<Record<Exclude<AgentOutcome, 'failed'>, string | undefined>> = {
  finished: undefined,
  max_iterations: 'max_iterations',
  max_duration: 'max_duration',
  stuck: 'agent_stuck',
  agent_error: 'agent_error',
};

function clockOf(deps: AgentDriveDeps): () => number {
  return deps.clock ?? Date.now;
}

function sleepOf(deps: AgentDriveDeps): (ms: number) => Promise<void> {
  return deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
}

function nowOf(deps: AgentDriveDeps): Date {
  return deps.now ? deps.now() : new Date();
}

/** LiteLLM's `alias:port` must be in the contract's egress list, or the agent cannot reach it. */
export function llmReachable(contract: RunContract, llmBaseUrl: string): boolean {
  const url = new URL(llmBaseUrl);
  return contract.egress_allowlist.includes(`${url.hostname}:${url.port}`);
}

/** Outcome of an agent that stopped by itself. */
export function outcomeOf(
  state: AgentRunState,
  iterations: number,
  maxIterations: number,
): AgentOutcome {
  if (state === 'finished') return 'finished';
  if (state === 'stuck') return 'stuck';
  if (state === 'max_iterations') return 'max_iterations';
  // Backstop when the agent does not say why it stopped: the step count reached the cap.
  if (iterations >= maxIterations) return 'max_iterations';
  return 'agent_error';
}

interface Polled {
  readonly state: AgentRunState;
  readonly iterations: number;
  readonly timedOut: boolean;
}

async function pollUntilDone(
  deps: AgentDriveDeps,
  handle: AgentRunHandle,
  deadline: number,
): Promise<Polled> {
  const clock = clockOf(deps);
  const sleep = sleepOf(deps);
  let errors = 0;
  let last = { state: 'running' as AgentRunState, iterations: 0 };
  for (;;) {
    try {
      last = await deps.adapter.getStatus(handle);
      errors = 0;
    } catch (error) {
      errors += 1;
      if (errors >= MAX_STATUS_ERRORS) throw error;
    }
    if (last.state !== 'running') return { ...last, timedOut: false };
    if (clock() >= deadline) return { ...last, timedOut: true };
    await sleep(Math.min(deps.settings.agent.pollMs, Math.max(0, deadline - clock())));
  }
}

/** Interrupt, then wait up to the grace period. `kill`: the agent did not stop in time. */
async function stopAtTimeCap(
  deps: AgentDriveDeps,
  handle: AgentRunHandle,
): Promise<{ method: 'interrupt' | 'kill'; iterations: number | undefined }> {
  const clock = clockOf(deps);
  const sleep = sleepOf(deps);
  const graceEnd = clock() + deps.settings.agent.stopGraceMs;
  try {
    await deps.adapter.stop(handle);
  } catch {
    return { method: 'kill', iterations: undefined };
  }
  for (;;) {
    try {
      const status = await deps.adapter.getStatus(handle);
      if (status.state !== 'running') return { method: 'interrupt', iterations: status.iterations };
    } catch {
      // keep trying until the grace period ends
    }
    if (clock() >= graceEnd) return { method: 'kill', iterations: undefined };
    await sleep(Math.min(deps.settings.agent.pollMs, Math.max(0, graceEnd - clock())));
  }
}

async function endRun(
  deps: AgentDriveDeps,
  scope: TenantScope,
  contract: RunContract,
  change: {
    readonly outcome: AgentOutcome;
    readonly status: RunStatus;
    readonly stopReason: string | undefined;
    readonly iterations: number | undefined;
    readonly outputs: AgentOutputs | undefined;
    readonly commit: 'committed' | 'nothing' | undefined;
  },
): Promise<RunStatus | undefined> {
  const now = nowOf(deps);
  const moved = await scope.runs.transition(contract.run_id, {
    from: ['running'],
    to: change.status,
    now,
    finishedAt: now,
    ...(change.stopReason ? { stopReason: change.stopReason } : {}),
    ...(change.outputs ? { headSha: change.outputs.headSha } : {}),
    ...(change.iterations === undefined ? {} : { iterations: change.iterations }),
  });
  await scope.runEvents.append(contract.run_id, 'agent_finished', {
    outcome: change.outcome,
    iterations: change.iterations ?? 0,
    ...(change.outputs
      ? { changed_files: change.outputs.changedFiles.length, head_sha: change.outputs.headSha }
      : {}),
    ...(change.commit ? { commit: change.commit } : {}),
  });
  return moved ? change.status : undefined;
}

async function failRun(
  deps: AgentDriveDeps,
  scope: TenantScope,
  contract: RunContract,
  reason: string,
): Promise<AgentRunResult> {
  await scope.runEvents.append(contract.run_id, 'agent_failed', { reason });
  const stopReason = reason.startsWith('agent_') ? reason : `agent_${reason}`;
  const now = nowOf(deps);
  const moved = await scope.runs.transition(contract.run_id, {
    from: ['running'],
    to: 'failed',
    now,
    finishedAt: now,
    stopReason,
  });
  return {
    outcome: 'failed',
    status: moved ? 'failed' : undefined,
    stopReason,
    outputs: undefined,
  };
}

/** Runs the agent of a provisioned run to its end. Never throws for agent or task failures. */
export async function driveAgent(
  deps: AgentDriveDeps,
  request: AgentRunRequest,
): Promise<AgentRunResult> {
  const { contract, sandbox } = request;
  const scope = deps.db.forTenant(parseTenantId(contract.tenant_id));
  const run = await scope.runs.getById(contract.run_id);
  if (run?.status !== 'running') throw new AgentRunError('run_not_running');

  let handle: AgentRunHandle;
  try {
    if (!llmReachable(contract, deps.settings.agent.llmBaseUrl)) {
      throw new AgentRunError('model_unreachable');
    }
    const task = await loadAgentTask(scope, contract);
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
      task,
      workingDir: AGENT_WORKING_DIR,
    });
  } catch (error) {
    return failRun(deps, scope, contract, failureCode(error));
  }
  await scope.runEvents.append(contract.run_id, 'agent_started', {
    max_iterations: contract.max_iterations,
    max_duration_min: contract.max_duration_min,
  });

  const deadline = clockOf(deps)() + contract.max_duration_min * 60_000;
  let polled: Polled;
  try {
    polled = await pollUntilDone(deps, handle, deadline);
  } catch (error) {
    return failRun(deps, scope, contract, failureCode(error));
  }

  let outcome: AgentOutcome;
  let iterations: number | undefined = polled.iterations;
  let reachable = true;
  if (polled.timedOut) {
    const stopped = await stopAtTimeCap(deps, handle);
    await scope.runEvents.append(contract.run_id, 'agent_stopped', {
      reason: 'max_duration',
      method: stopped.method,
    });
    outcome = 'max_duration';
    iterations = stopped.iterations ?? iterations;
    reachable = stopped.method === 'interrupt';
  } else {
    outcome = outcomeOf(polled.state, polled.iterations, contract.max_iterations);
  }

  let commit: 'committed' | 'nothing' | undefined;
  let outputs: AgentOutputs | undefined;
  if (reachable) {
    try {
      if (outcome === 'finished') {
        const done = await deps.adapter.commitWork(handle, {
          branch: contract.branch,
          author: agentCommitAuthor(contract),
          message: `sdlc: agent run ${contract.run_id}`,
        });
        commit = done.committed ? 'committed' : 'nothing';
      }
      outputs = await deps.adapter.collectOutputs(handle, contract.base_sha);
      iterations = outputs.iterations;
    } catch (error) {
      return failRun(deps, scope, contract, failureCode(error));
    }
  }

  const status = STATUS_OF[outcome as Exclude<AgentOutcome, 'failed'>];
  const stopReason = STOP_REASON_OF[outcome as Exclude<AgentOutcome, 'failed'>];
  const set = await endRun(deps, scope, contract, {
    outcome,
    status,
    stopReason,
    iterations,
    outputs,
    commit,
  });
  return { outcome, status: set, stopReason, outputs };
}

function failureCode(error: unknown): string {
  if (error instanceof AgentRunError) return error.reason;
  if (error instanceof AgentError) return error.code;
  return 'runner_error';
}
