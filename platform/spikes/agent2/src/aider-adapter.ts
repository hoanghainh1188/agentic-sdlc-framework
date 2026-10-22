// X01 spike (design/ADR-M68): `AgentAdapter` on Aider 0.86.2 through the spike's supervisor
// (images/aider/supervisor.mjs, port 8000). Thrown away after X01.
//
// Mapping (ADR-M68 §3):
// - startRun: `POST /run` with the model, the LiteLLM URL, the virtual key (Aider's process only),
//   the cap, the task message as a file, the plan's files (`--file`) and AGENTS.md (`--read`).
//   Aider cannot find files by itself: it edits only what is added to its chat.
// - getStatus: `GET /status`; one step = one model reply. Aider has no tool calls: identical
//   replies at the end stand in for identical calls.
// - stop: `POST /stop` (SIGINT, then SIGKILL).
// - commitWork / collectOutputs: the ADR-M29 git commands through `POST /bash`.
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
import {
  commitCommand,
  diffCommand,
  INSTRUCTIONS_FILE,
  parseCommitOutput,
  parseDiffOutput,
} from '@sdlc/adapter-agent-openhands';

import { call, checkStart, taskMessage, type HttpOptions } from './common.js';

export const FINISH_RULE_AIDER = '- Make all the changes in this one reply set; then stop.';

/** Where the task message goes in the sandbox (the supervisor's tmpfs). */
const MESSAGE_FILE = '/tmp/aider/task.md';

export interface AiderOptions {
  /** The project's check command: Aider runs it after each edit and fixes failures (`--auto-test`). */
  readonly testCmd?: string;
  /** Model context window, passed as Aider model metadata. */
  readonly contextTokens: number;
  readonly timeoutMs?: number;
}

const STATES: readonly AgentRunState[] = [
  'running',
  'finished',
  'max_iterations',
  'stopped',
  'error',
];

export class AiderAdapter implements AgentAdapter {
  constructor(private readonly options: AiderOptions) {}

  #http(handle: Pick<AgentRunHandle, 'endpoint'>): HttpOptions {
    return {
      baseUrl: handle.endpoint.baseUrl,
      authorization: `Bearer ${handle.endpoint.sessionKey.reveal()}`,
      timeoutMs: this.options.timeoutMs ?? 120_000,
    };
  }

  async #bash(handle: Pick<AgentRunHandle, 'endpoint'>, command: string) {
    return call<{ exitCode: number; stdout: string }>(this.#http(handle), 'POST', '/bash', {
      command,
    });
  }

  async startRun(input: StartAgentRun): Promise<AgentRunHandle> {
    checkStart(input);
    const http = this.#http(input);
    // The message goes in as a file through the supervisor's shell: base64 keeps it one argument.
    const encoded = Buffer.from(taskMessage(input, FINISH_RULE_AIDER)).toString('base64');
    const written = await this.#bash(
      input,
      `mkdir -p /tmp/aider && echo '${encoded}' | base64 -d > ${MESSAGE_FILE}`,
    );
    if (written.exitCode !== 0) throw new AgentError('server_error');
    // Plan patterns are exact paths in the pilot tasks; Aider creates a named file that is missing.
    const files = input.task.plan.plannedFiles.filter((f) => !/[*?[]/.test(f));
    await call(http, 'POST', '/run', {
      model: input.model.model,
      baseUrl: `${input.model.baseUrl}/v1`,
      key: input.model.virtualKey.reveal(),
      maxIterations: input.contract.max_iterations,
      contextTokens: this.options.contextTokens,
      messageFile: MESSAGE_FILE,
      files,
      readFiles: [INSTRUCTIONS_FILE, input.task.spec.path],
      testCmd: this.options.testCmd ?? null,
    });
    return {
      runId: input.contract.run_id,
      conversationId: 'aider',
      endpoint: input.endpoint,
      workingDir: input.workingDir,
    };
  }

  async getStatus(handle: AgentRunHandle): Promise<AgentRunStatus> {
    const s = await call<{
      state: string;
      iterations: number;
      events: number;
      identicalCalls: number;
    }>(this.#http(handle), 'GET', '/status');
    const state = s.state === 'idle' ? 'running' : (s.state as AgentRunState);
    if (!STATES.includes(state)) throw new AgentError('invalid_response');
    return {
      state,
      iterations: s.iterations,
      events: s.events,
      identicalCalls: s.identicalCalls,
    };
  }

  async stop(handle: AgentRunHandle): Promise<void> {
    await call(this.#http(handle), 'POST', '/stop');
  }

  async commitWork(
    handle: AgentRunHandle,
    input: {
      readonly branch: string;
      readonly author: AgentCommitAuthor;
      readonly message: string;
    },
  ): Promise<AgentCommit> {
    const r = await this.#bash(handle, commitCommand({ workingDir: handle.workingDir, ...input }));
    const answer = parseCommitOutput(r.stdout);
    if (answer.branchChanged) throw new AgentError('branch_changed');
    if (r.exitCode !== 0 || !answer.headSha) {
      throw new AgentError('git_failed', { exit_code: r.exitCode });
    }
    return { headSha: answer.headSha, committed: answer.committed };
  }

  async collectOutputs(handle: AgentRunHandle, baseSha: string): Promise<AgentOutputs> {
    const r = await this.#bash(handle, diffCommand(handle.workingDir, baseSha));
    if (r.exitCode !== 0) throw new AgentError('git_failed', { exit_code: r.exitCode });
    const { headSha, changedFiles } = parseDiffOutput(r.stdout);
    const { events } = await call<{ events: Record<string, unknown>[] }>(
      this.#http(handle),
      'GET',
      '/events',
    );
    return { changedFiles, headSha, iterations: events.length, events };
  }
}
