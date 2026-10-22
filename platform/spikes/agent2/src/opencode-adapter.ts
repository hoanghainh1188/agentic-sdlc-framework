// X01 spike (design/ADR-M68): `AgentAdapter` on OpenCode 1.18.35's HTTP server (`opencode serve`,
// started by images/opencode/entry.sh on port 8000). Thrown away after X01; X03 builds the real one.
//
// Mapping (ADR-M68 §3):
// - startRun: the virtual key through `PUT /auth/litellm` (never an environment variable), the
//   run's model and the step cap through `PATCH /global/config`, a session, then `prompt_async` with the
//   task message and a tool map (only the tools the contract allows).
// - getStatus: `GET /session/status` (busy, retry, idle) and `GET /session/:id/message`.
//   One step = one `step-finish` part (one model reply). Loop counts from the `tool` parts.
// - stop: `POST /session/:id/abort`.
// - commitWork / collectOutputs: the ADR-M29 git commands through `POST /session/:id/shell`.
import crypto from 'node:crypto';

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
import {
  canonicalArguments,
  commitCommand,
  diffCommand,
  parseCommitOutput,
  parseDiffOutput,
} from '@sdlc/adapter-agent-openhands';

import { call, checkStart, taskMessage, type HttpOptions } from './common.js';

const PROVIDER = 'litellm';
const AGENT = 'build';

/** Platform tool → OpenCode tools. Everything else is switched off for the run. */
const TOOL_MAP: Readonly<Record<string, readonly string[]>> = {
  file_editor: [
    'read',
    'edit',
    'write',
    'patch',
    'multiedit',
    'glob',
    'grep',
    'list',
    'apply_patch',
  ],
  terminal: ['bash'],
  task_tracker: ['todowrite', 'todoread'],
};

interface Part {
  readonly type: string;
  readonly tool?: string;
  readonly reason?: string;
  readonly state?: { readonly status?: string; readonly input?: unknown; readonly output?: string };
}
interface Message {
  readonly info: {
    readonly role: string;
    readonly error?: { readonly name?: string };
    readonly time?: { readonly completed?: number };
  };
  readonly parts: readonly Part[];
}

/**
 * OpenCode's shell endpoint evaluates the command once more (`eval`), so `$…` would expand too
 * early (found in the spike). The script travels base64-encoded and runs in its own `sh`.
 */
export function wrapped(script: string): string {
  const encoded = Buffer.from(`${script}\necho "sdlc:exit:$?"\n`).toString('base64');
  return `echo ${encoded} | base64 -d | sh`;
}

export const FINISH_RULE_OPENCODE =
  '- When the task is done, stop and reply with a short summary (no further tool calls).';

export class OpenCodeAdapter implements AgentAdapter {
  constructor(private readonly timeoutMs = 120_000) {}

  #http(handle: Pick<AgentRunHandle, 'endpoint'>): HttpOptions {
    const basic = Buffer.from(`opencode:${handle.endpoint.sessionKey.reveal()}`).toString('base64');
    return {
      baseUrl: handle.endpoint.baseUrl,
      authorization: `Basic ${basic}`,
      timeoutMs: this.timeoutMs,
    };
  }

  async startRun(input: StartAgentRun): Promise<AgentRunHandle> {
    const tools = checkStart(input);
    rememberCap(input.contract.run_id, input.contract.max_iterations);
    const http = this.#http(input);
    await call(http, 'PUT', `/auth/${PROVIDER}`, {
      type: 'api',
      key: input.model.virtualKey.reveal(),
    });
    // `PATCH /config` writes `config.json` into the repository root (a change outside the plan,
    // found in the spike); the global configuration lives in the home directory (tmpfs).
    await call(http, 'PATCH', '/global/config', {
      provider: {
        [PROVIDER]: {
          npm: '@ai-sdk/openai-compatible',
          options: { baseURL: `${input.model.baseUrl}/v1` },
          models: { [input.model.model]: { name: input.model.model, tool_call: true } },
        },
      },
      agent: { [AGENT]: { steps: input.contract.max_iterations } },
    });
    // The patched configuration applies to a new instance only.
    await call(http, 'POST', '/instance/dispose');
    const ids = await call<string[]>(http, 'GET', '/experimental/tool/ids');
    const allowed = new Set(tools.flatMap((t) => TOOL_MAP[t] ?? []));
    const toolMap = Object.fromEntries(ids.map((id) => [id, allowed.has(id)]));
    const session = await call<{ id: string }>(http, 'POST', '/session', {});
    await call(http, 'POST', `/session/${session.id}/prompt_async`, {
      model: { providerID: PROVIDER, modelID: input.model.model },
      agent: AGENT,
      tools: toolMap,
      parts: [{ type: 'text', text: taskMessage(input, FINISH_RULE_OPENCODE) }],
    });
    return {
      runId: input.contract.run_id,
      conversationId: session.id,
      endpoint: input.endpoint,
      workingDir: input.workingDir,
    };
  }

  async #messages(handle: AgentRunHandle): Promise<readonly Message[]> {
    return call<Message[]>(this.#http(handle), 'GET', `/session/${handle.conversationId}/message`);
  }

  async getStatus(handle: AgentRunHandle): Promise<AgentRunStatus> {
    const http = this.#http(handle);
    const statuses = await call<Record<string, { type: string }>>(http, 'GET', '/session/status');
    const busy = statuses[handle.conversationId]?.type;
    const messages = await this.#messages(handle);
    const counts = countsOf(messages);
    const assistant = messages.filter((m) => m.info.role === 'assistant');
    if (busy === 'busy' || busy === 'retry' || assistant.length === 0) {
      // The step cap is enforced here as well: the spike found OpenCode's own `steps` not to hold.
      if (counts.iterations >= capOf(handle)) {
        adapterCapStops.add(handle.runId);
        await call(http, 'POST', `/session/${handle.conversationId}/abort`);
        return { state: 'max_iterations', ...counts };
      }
      return { state: 'running', ...counts };
    }
    if (adapterCapStops.has(handle.runId)) return { state: 'max_iterations', ...counts };
    const last = assistant[assistant.length - 1]!;
    const error = last.info.error?.name;
    if (error === 'MessageAbortedError') return { state: 'stopped', ...counts };
    if (error !== undefined) return { state: 'error', ...counts };
    if (counts.iterations >= capOf(handle)) return { state: 'max_iterations', ...counts };
    return { state: 'finished', ...counts };
  }

  async stop(handle: AgentRunHandle): Promise<void> {
    await call(this.#http(handle), 'POST', `/session/${handle.conversationId}/abort`);
  }

  async #shell(handle: AgentRunHandle, command: string): Promise<string> {
    const message = await call<Message>(
      this.#http(handle),
      'POST',
      `/session/${handle.conversationId}/shell`,
      { agent: AGENT, command: wrapped(command) },
    );
    const tool = message.parts.find((p) => p.type === 'tool');
    return tool?.state?.output ?? '';
  }

  async commitWork(
    handle: AgentRunHandle,
    input: {
      readonly branch: string;
      readonly author: AgentCommitAuthor;
      readonly message: string;
    },
  ): Promise<AgentCommit> {
    const out = await this.#shell(
      handle,
      commitCommand({ workingDir: handle.workingDir, ...input }),
    );
    const answer = parseCommitOutput(out);
    if (answer.branchChanged) throw new AgentError('branch_changed');
    if (!answer.headSha) throw new AgentError('git_failed');
    return { headSha: answer.headSha, committed: answer.committed };
  }

  async collectOutputs(handle: AgentRunHandle, baseSha: string): Promise<AgentOutputs> {
    const out = await this.#shell(handle, diffCommand(handle.workingDir, baseSha));
    if (!/sdlc:exit:0\s*$/.test(out)) throw new AgentError('git_failed');
    const { headSha, changedFiles } = parseDiffOutput(out);
    const messages = await this.#messages(handle);
    // The log as evidence: kinds and hashes only in this spike (the texts stay in the sandbox).
    const events = messages.flatMap((m) =>
      m.parts.map((p) => ({ role: m.info.role, type: p.type, tool: p.tool ?? null })),
    );
    return { changedFiles, headSha, iterations: countsOf(messages).iterations, events };
  }
}

/** The cap is in the contract; the handle keeps it for the status mapping. */
const caps = new Map<string, number>();
/** Runs the adapter stopped at the cap (the spike reports how often OpenCode did not). */
export const adapterCapStops = new Set<string>();
const rememberCap = (runId: string, cap: number): void => void caps.set(runId, cap);
const capOf = (handle: AgentRunHandle): number => caps.get(handle.runId) ?? Infinity;

export function countsOf(messages: readonly Message[]): {
  iterations: number;
  events: number;
  identicalCalls: number;
} {
  const parts = messages.flatMap((m) => m.parts);
  const iterations = parts.filter((p) => p.type === 'step-finish').length;
  const calls = parts
    .filter((p) => p.type === 'tool' && p.tool !== undefined)
    .map((p) =>
      crypto
        .createHash('sha256')
        .update(`${p.tool!}\n${canonicalArguments(p.state?.input ?? {})}`)
        .digest('hex'),
    );
  let identicalCalls = 0;
  for (let i = calls.length - 1; i >= 0 && calls[i] === calls[calls.length - 1]; i--) {
    identicalCalls += 1;
  }
  return { iterations, events: parts.length, identicalCalls };
}
