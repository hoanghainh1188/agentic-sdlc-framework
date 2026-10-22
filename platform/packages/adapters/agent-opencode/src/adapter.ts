// `AgentAdapter` on OpenCode 1.18.35's HTTP server (design/D-08 X03, ADR-M68 §4, ADR-M88). One
// session per sandbox. The entry script of the image `node24-opencode` starts `opencode serve` on
// port 8000 with the run's session key as the server password.
//
// The server password is in OpenCode's environment, so the agent's shell can call its own server
// (ADR-M68 §6 gap 1). The runner never trusts the agent's own limits (QUESTIONS #523):
// - before the agent starts, the configuration in effect must be what the run needs (a
//   repository's `opencode.json` ranks above the global configuration);
// - the adapter enforces the iteration cap from the session's step count: it aborts at the cap
//   until the session is idle (waiting up to `capSettleMs` each time). The counts it reports
//   never go down, so deleting or reverting messages through the server does not undo steps;
// - after `startRun` it keeps a fingerprint of the configuration in effect, the tool IDs and the
//   session IDs; every status read compares it again, and on any change it aborts the session and
//   fails the run with `config_changed`. An agent can never change its own limits, tools or MCP
//   servers, or start a session of its own.
// What remains (a change made and undone between two reads) waits for the authenticating proxy
// that holds the password before real client work (QUESTIONS #523). The time cap and the LiteLLM
// budget stop a run in any case.
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
  effectiveConfigProblem,
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
  /** How long a status read waits for the session to go idle after an abort at the cap. Default 10 s. */
  readonly capSettleMs?: number;
}

/** Between two reads of the session state while an abort at the cap settles. */
const SETTLE_POLL_MS = 250;

/** What the adapter keeps of a run it started: no secret, no client data. */
interface RunState {
  readonly cap: number;
  readonly fingerprint: string;
  readonly stoppedAtCap: boolean;
  readonly configChanged: boolean;
  /** The highest counts reported so far: they never go down. */
  readonly iterations: number;
  readonly events: number;
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

  /**
   * SHA-256 of the configuration in effect, the tool IDs and the session IDs (RFC 8785 canonical
   * JSON). `known` gives values already read, so one read serves both the prompt and the baseline.
   */
  async #fingerprint(
    client: OpenCodeClient,
    known: { readonly config?: unknown; readonly ids?: readonly string[] } = {},
  ): Promise<string> {
    const [global, config, ids, sessions] = await Promise.all([
      client.globalConfig(),
      known.config === undefined ? client.config() : Promise.resolve(known.config),
      known.ids ?? client.toolIds(),
      client.sessionIds(),
    ]);
    const canonical = canonicalArguments(
      { global, config, tools: [...ids].sort(), sessions: [...sessions].sort() },
      false,
    );
    return createHash('sha256').update(canonical, 'utf8').digest('hex');
  }

  async startRun(input: StartAgentRun): Promise<AgentRunHandle> {
    const tools = checkStart(input);
    const client = this.#client(input);
    await client.setApiKey(PROVIDER, input.model.virtualKey.reveal());
    await client.patchGlobalConfig(globalConfig(input));
    await client.disposeInstance();
    const config = await client.config();
    const problem = effectiveConfigProblem(config, input);
    if (problem !== undefined) throw new AgentError('config_changed', { field: problem });
    const ids = await client.toolIds();
    const sessionId = await client.createSession();
    const fingerprint = await this.#fingerprint(client, { config, ids });
    this.#remember(input.contract.run_id, {
      cap: input.contract.max_iterations,
      fingerprint,
      stoppedAtCap: false,
      configChanged: false,
      iterations: 0,
      events: 0,
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
    const counted = countsOf(messages);
    const iterations = Math.max(run.iterations, counted.iterations);
    const counts = {
      iterations,
      events: Math.max(run.events, counted.events),
      identicalCalls: counted.identicalCalls,
    };
    const stoppedAtCap = run.stoppedAtCap || (session !== 'idle' && iterations >= run.cap);
    this.#runs.set(handle.runId, { ...run, ...counts, stoppedAtCap });
    if (stoppedAtCap && session !== 'idle') {
      // At the cap: abort, and wait a short time for the session to go idle, so the platform's
      // git commands find an idle session and the cap (not a loop check) ends the run. When it is
      // still busy, report `running`: the next read aborts again.
      await client.abort(handle.conversationId);
      if (!(await this.#settled(client, handle.conversationId))) {
        return { state: 'running', ...counts };
      }
      return { state: 'max_iterations', ...counts };
    }
    const state = stateOf({ session, messages, iterations, cap: run.cap, stoppedAtCap });
    return { state, ...counts };
  }

  async #settled(client: OpenCodeClient, sessionId: string): Promise<boolean> {
    const deadline = Date.now() + (this.#options.capSettleMs ?? 10_000);
    for (;;) {
      if ((await client.sessionState(sessionId)) === 'idle') return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
    }
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
    // The log as evidence (E02): every part with the role of its message, oldest first. The
    // session key is the server password, which the agent's shell can print: it never reaches
    // the evidence.
    const key = handle.endpoint.sessionKey.reveal();
    const events = messages.flatMap((message) =>
      message.parts.map((part) => withoutKey({ role: message.info.role, ...part }, key)),
    );
    const iterations = Math.max(
      this.#runs.get(handle.runId)?.iterations ?? 0,
      countsOf(messages).iterations,
    );
    return { changedFiles, headSha, iterations, events };
  }

  // The answer of a wrapped command must end with its exit code (`exitCodeOf`). An answer the
  // server cut at its output limit fails closed as `git_failed`: a diff of very many files.
  #gitTimeout(): number {
    return this.#options.gitTimeoutSeconds ?? 120;
  }
}

/** A copy of `event` with every occurrence of `key` replaced. */
function withoutKey(
  event: Readonly<Record<string, unknown>>,
  key: string,
): Record<string, unknown> {
  const text = JSON.stringify(event);
  if (key === '' || !text.includes(key)) return { ...event };
  return JSON.parse(text.replaceAll(key, '[redacted]')) as Record<string, unknown>;
}
