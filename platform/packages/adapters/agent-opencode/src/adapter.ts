// `AgentAdapter` on OpenCode 1.18.35's HTTP server (design/D-08 X03, ADR-M68 §4, ADR-M88). One
// session per sandbox. The entry script of the image `node24-opencode` starts `opencode serve` on
// port 8000 with the run's session key as the server password.
//
// The server password is in OpenCode's environment, so the agent's shell can call its own server
// (ADR-M68 §6 gap 1). The runner never trusts the agent's own limits (QUESTIONS #523):
// - the adapter enforces the iteration cap from the session's step count, and aborts at the cap;
// - after `startRun` it keeps a fingerprint of the configuration in effect and of the tool IDs;
//   every status read compares it again, and on any change it aborts the session and fails the
//   run with `config_changed`. An agent can never change its own limits, tools or MCP servers.
import { createHash } from 'node:crypto';

import {
  canonicalArguments,
  commitCommand,
  diffCommand,
  parseCommitOutput,
  parseDiffOutput,
} from '@sdlc/agent-kit';
import {
  AgentError,
  type AgentAdapter,
  type AgentCommit,
  type AgentCommitAuthor,
  type AgentOutputs,
  type AgentRunHandle,
  type AgentRunStatus,
  type StartAgentRun,
} from '@sdlc/contracts';

import { OpenCodeClient, type OpenCodeClientOptions } from './client.js';
import {
  AGENT,
  checkStart,
  exitCodeOf,
  globalConfig,
  PROVIDER,
  promptBody,
  toolSwitches,
  wrapped,
} from './request.js';
import { countsOf, stateOf } from './status.js';

export interface OpenCodeAdapterOptions {
  /** Per request. Default 30 s. */
  readonly requestTimeoutMs?: number;
  /** Time limit of the platform's own git commands in the sandbox. Default 120 s. */
  readonly gitTimeoutSeconds?: number;
  /** For tests. Default: the global `fetch`. */
  readonly fetch?: typeof fetch;
}

/** What the adapter keeps of a run it started: no secret, no client data. */
interface RunState {
  readonly cap: number;
  readonly fingerprint: string;
  readonly stoppedAtCap: boolean;
  readonly configChanged: boolean;
}

/** Runs kept in memory; the oldest go first (a runner drives 1–2 runs at a time). */
const MAX_RUNS = 256;

export class OpenCodeAdapter implements AgentAdapter {
  readonly #options: OpenCodeAdapterOptions;
  readonly #runs = new Map<string, RunState>();

  constructor(options: OpenCodeAdapterOptions = {}) {
    this.#options = options;
  }

  #client(handle: Pick<AgentRunHandle, 'endpoint'>): OpenCodeClient {
    const options: OpenCodeClientOptions = {
      baseUrl: handle.endpoint.baseUrl,
      password: handle.endpoint.sessionKey.reveal(),
      ...(this.#options.requestTimeoutMs ? { timeoutMs: this.#options.requestTimeoutMs } : {}),
      ...(this.#options.fetch ? { fetch: this.#options.fetch } : {}),
    };
    return new OpenCodeClient(options);
  }

  /** SHA-256 of the configuration in effect and the tool IDs (RFC 8785 canonical JSON). */
  async #fingerprint(client: OpenCodeClient): Promise<string> {
    const [global, config, ids] = await Promise.all([
      client.globalConfig(),
      client.config(),
      client.toolIds(),
    ]);
    const canonical = canonicalArguments({ global, config, tools: [...ids].sort() }, false);
    return createHash('sha256').update(canonical, 'utf8').digest('hex');
  }

  async startRun(input: StartAgentRun): Promise<AgentRunHandle> {
    const tools = checkStart(input);
    const client = this.#client(input);
    await client.setApiKey(PROVIDER, input.model.virtualKey.reveal());
    await client.patchGlobalConfig(globalConfig(input));
    await client.disposeInstance();
    const ids = await client.toolIds();
    const fingerprint = await this.#fingerprint(client);
    const sessionId = await client.createSession();
    this.#remember(input.contract.run_id, {
      cap: input.contract.max_iterations,
      fingerprint,
      stoppedAtCap: false,
      configChanged: false,
    });
    await client.promptAsync(sessionId, promptBody(input, toolSwitches(ids, tools)));
    return {
      runId: input.contract.run_id,
      conversationId: sessionId,
      endpoint: input.endpoint,
      workingDir: input.workingDir,
    };
  }

  #remember(runId: string, state: RunState): void {
    this.#runs.delete(runId);
    this.#runs.set(runId, state);
    while (this.#runs.size > MAX_RUNS) {
      const oldest = this.#runs.keys().next().value;
      if (oldest === undefined) break;
      this.#runs.delete(oldest);
    }
  }

  /** The run's state; a run this adapter did not start fails closed. */
  #run(handle: AgentRunHandle): RunState {
    const run = this.#runs.get(handle.runId);
    if (!run) throw new AgentError('invalid_input', { field: 'run_id' });
    return run;
  }

  async getStatus(handle: AgentRunHandle): Promise<AgentRunStatus> {
    const run = this.#run(handle);
    const client = this.#client(handle);
    if (run.configChanged) throw new AgentError('config_changed');
    if ((await this.#fingerprint(client)) !== run.fingerprint) {
      this.#runs.set(handle.runId, { ...run, configChanged: true });
      await client.abort(handle.conversationId).catch(() => undefined);
      throw new AgentError('config_changed');
    }
    const session = await client.sessionState(handle.conversationId);
    const messages = await client.messages(handle.conversationId);
    const counts = countsOf(messages);
    if (session !== 'idle' && !run.stoppedAtCap && counts.iterations >= run.cap) {
      this.#runs.set(handle.runId, { ...run, stoppedAtCap: true });
      await client.abort(handle.conversationId);
      return { state: 'max_iterations', ...counts };
    }
    const state = stateOf({
      session,
      messages,
      iterations: counts.iterations,
      cap: run.cap,
      stoppedAtCap: run.stoppedAtCap,
    });
    return { state, ...counts };
  }

  async stop(handle: AgentRunHandle): Promise<void> {
    await this.#client(handle).abort(handle.conversationId);
  }

  async #shell(handle: AgentRunHandle, script: string): Promise<{ out: string; exit: number }> {
    const out = await this.#client(handle).shell(
      handle.conversationId,
      AGENT,
      wrapped(script),
      this.#gitTimeout() * 1000,
    );
    const exit = exitCodeOf(out);
    if (exit === undefined) throw new AgentError('git_failed', { exit_code: -1 });
    return { out, exit };
  }

  async commitWork(
    handle: AgentRunHandle,
    input: {
      readonly branch: string;
      readonly author: AgentCommitAuthor;
      readonly message: string;
    },
  ): Promise<AgentCommit> {
    const { out, exit } = await this.#shell(
      handle,
      commitCommand({ workingDir: handle.workingDir, ...input }),
    );
    const answer = parseCommitOutput(out);
    if (answer.branchChanged) throw new AgentError('branch_changed');
    if (exit !== 0 || !answer.headSha) throw new AgentError('git_failed', { exit_code: exit });
    return { headSha: answer.headSha, committed: answer.committed };
  }

  async collectOutputs(handle: AgentRunHandle, baseSha: string): Promise<AgentOutputs> {
    const { out, exit } = await this.#shell(handle, diffCommand(handle.workingDir, baseSha));
    if (exit !== 0) throw new AgentError('git_failed', { exit_code: exit });
    const { headSha, changedFiles } = parseDiffOutput(out);
    const messages = await this.#client(handle).messages(handle.conversationId);
    // The log as evidence (E02): every part with the role of its message, oldest first.
    const events = messages.flatMap((message) =>
      message.parts.map((part) => ({ role: message.info.role, ...part })),
    );
    return { changedFiles, headSha, iterations: countsOf(messages).iterations, events };
  }

  #gitTimeout(): number {
    return this.#options.gitTimeoutSeconds ?? 120;
  }
}
