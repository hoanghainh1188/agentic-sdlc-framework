// `AgentAdapter` on the OpenHands Agent Server 1.48.0 (design/D-03 §7.2, D-08 C05, ADR-M10,
// ADR-M29). One conversation per sandbox (ADR-M10 §4.1 item 5).
import {
  AgentError,
  type AgentAdapter,
  type AgentCommit,
  type AgentCommitAuthor,
  type AgentOutputs,
  type AgentRunHandle,
  type AgentRunState,
  type AgentRunStatus,
  type StartAgentRun,
} from '@sdlc/contracts';

import { AgentServerClient, type ClientOptions, type ExecutionStatus } from './client.js';
import { commitCommand, diffCommand, parseCommitOutput, parseDiffOutput } from './git.js';
import { buildConversationRequest } from './request.js';

export interface OpenHandsAdapterOptions {
  /** Per request. Default 30 s. */
  readonly requestTimeoutMs?: number;
  /** Time limit of the platform's own git commands in the sandbox. Default 120 s. */
  readonly gitTimeoutSeconds?: number;
  /** For tests. Default: the global `fetch`. */
  readonly fetch?: typeof fetch;
}

/** One agent step = one tool call (`ActionEvent`). Parallel calls in one reply count each. */
const STEP_EVENT = 'ActionEvent';

/**
 * Error code the Agent Server 1.48.0 writes when the agent reaches `max_iterations` (found in the
 * C05 live test): a `ConversationErrorEvent`, then status `error`.
 */
export const MAX_ITERATIONS_CODE = 'MaxIterationsReached';
const ERROR_EVENT = 'ConversationErrorEvent';

/**
 * Agent Server status → agent state. `idle` before the first step means "not started yet";
 * after it, the loop ended without `finish` (for example at `max_iterations`). `paused` follows
 * the platform's interrupt. `waiting_for_confirmation` cannot happen (no confirmation policy) and
 * fails closed as an error.
 */
export function toAgentState(status: ExecutionStatus, iterations: number): AgentRunState {
  switch (status) {
    case 'running':
      return 'running';
    case 'idle':
      return iterations === 0 ? 'running' : 'stopped';
    case 'finished':
      return 'finished';
    case 'paused':
    case 'deleting':
      return 'stopped';
    case 'stuck':
      return 'stuck';
    case 'error':
    case 'waiting_for_confirmation':
      return 'error';
  }
}

export class OpenHandsAdapter implements AgentAdapter {
  readonly #options: OpenHandsAdapterOptions;

  constructor(options: OpenHandsAdapterOptions = {}) {
    this.#options = options;
  }

  #client(handle: Pick<AgentRunHandle, 'endpoint'>): AgentServerClient {
    const options: ClientOptions = {
      baseUrl: handle.endpoint.baseUrl,
      sessionKey: handle.endpoint.sessionKey.reveal(),
      ...(this.#options.requestTimeoutMs ? { timeoutMs: this.#options.requestTimeoutMs } : {}),
      ...(this.#options.fetch ? { fetch: this.#options.fetch } : {}),
    };
    return new AgentServerClient(options);
  }

  async startRun(input: StartAgentRun): Promise<AgentRunHandle> {
    const body = buildConversationRequest({
      contract: input.contract,
      model: input.model.model,
      llmBaseUrl: input.model.baseUrl,
      virtualKey: input.model.virtualKey.reveal(),
      workingDir: input.workingDir,
      task: input.task,
    });
    const conversationId = await this.#client(input).startConversation(body);
    return {
      runId: input.contract.run_id,
      conversationId,
      endpoint: input.endpoint,
      workingDir: input.workingDir,
    };
  }

  async getStatus(handle: AgentRunHandle): Promise<AgentRunStatus> {
    const client = this.#client(handle);
    const status = await client.executionStatus(handle.conversationId);
    // The `kind` filter of the events endpoints matches nothing in 1.48.0 (found in the C05 live
    // test), so the adapter reads the whole log and filters here.
    const events = await client.listEvents(handle.conversationId);
    const iterations = events.filter((event) => event.kind === STEP_EVENT).length;
    const state = toAgentState(status, iterations);
    if (
      (state === 'error' || state === 'stopped') &&
      events.some((e) => e.kind === ERROR_EVENT && e.code === MAX_ITERATIONS_CODE)
    ) {
      return { state: 'max_iterations', iterations };
    }
    return { state, iterations };
  }

  async stop(handle: AgentRunHandle): Promise<void> {
    await this.#client(handle).interrupt(handle.conversationId);
  }

  async commitWork(
    handle: AgentRunHandle,
    input: {
      readonly branch: string;
      readonly author: AgentCommitAuthor;
      readonly message: string;
    },
  ): Promise<AgentCommit> {
    const command = commitCommand({ workingDir: handle.workingDir, ...input });
    const result = await this.#client(handle).executeBash(
      command,
      handle.workingDir,
      this.#gitTimeout(),
    );
    const answer = parseCommitOutput(result.stdout);
    if (answer.branchChanged) throw new AgentError('branch_changed');
    if (result.exitCode !== 0 || !answer.headSha) {
      throw new AgentError('git_failed', { exit_code: result.exitCode ?? -1 });
    }
    return { headSha: answer.headSha, committed: answer.committed };
  }

  async collectOutputs(handle: AgentRunHandle, baseSha: string): Promise<AgentOutputs> {
    const client = this.#client(handle);
    const diff = await client.executeBash(
      diffCommand(handle.workingDir, baseSha),
      handle.workingDir,
      this.#gitTimeout(),
    );
    if (diff.exitCode !== 0) throw new AgentError('git_failed', { exit_code: diff.exitCode ?? -1 });
    const { headSha, changedFiles } = parseDiffOutput(diff.stdout);
    const events = await client.listEvents(handle.conversationId);
    const iterations = events.filter((event) => event.kind === STEP_EVENT).length;
    return { changedFiles, headSha, iterations, events };
  }

  #gitTimeout(): number {
    return this.#options.gitTimeoutSeconds ?? 120;
  }
}
