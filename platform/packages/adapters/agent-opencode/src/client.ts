// Thin REST client for OpenCode 1.18.35's HTTP server (`opencode serve`; design/ADR-M68 §3.1, §4).
// Endpoints checked against the OpenAPI description the pinned image serves at `/doc`.
//
// - Every call sends the per-run session key as the server password (HTTP Basic, user
//   `opencode`); only the runner holds it. The image's entry script makes it the password.
// - Fails closed: a status or shape it does not know is `invalid_response`.
// - Errors never carry text from the server (it can echo the model's output or the request).
// - Bodies are read up to a size limit, so a huge answer never fills the runner's memory.
import { AgentError } from '@sdlc/contracts';

/** The user name of OpenCode's HTTP Basic authentication. */
export const SERVER_USER = 'opencode';

export interface OpenCodeClientOptions {
  readonly baseUrl: string;
  /** The run's session key, which the sandbox's entry script made the server password. */
  readonly password: string;
  /** Per request. Default 30 s. */
  readonly timeoutMs?: number;
  /** Largest response body read. Default 16 MiB. */
  readonly maxResponseBytes?: number;
  /** For tests. Default: the global `fetch`. */
  readonly fetch?: typeof fetch;
}

/** One part of a message: a model step, a tool call, text. Only the fields the adapter reads. */
export interface OpenCodePart {
  readonly type: string;
  readonly tool?: string;
  readonly state?: {
    readonly status?: string;
    readonly input?: unknown;
    readonly output?: string;
  };
  readonly [key: string]: unknown;
}

export interface OpenCodeMessage {
  readonly info: {
    readonly role: string;
    readonly error?: { readonly name?: string };
    readonly [key: string]: unknown;
  };
  readonly parts: readonly OpenCodePart[];
}

/** `SessionStatus.type` of OpenCode 1.18.35. */
export type SessionState = 'idle' | 'busy' | 'retry';
const SESSION_STATES: readonly string[] = ['idle', 'busy', 'retry'];

const SESSION_ID = /^ses_[A-Za-z0-9]{1,64}$/;
const TOOL_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sessionPath(sessionId: string): string {
  if (!SESSION_ID.test(sessionId)) throw new AgentError('invalid_input', { field: 'session_id' });
  return `/session/${sessionId}`;
}

function isPart(value: unknown): value is OpenCodePart {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  if (value.tool !== undefined && typeof value.tool !== 'string') return false;
  return value.state === undefined || isRecord(value.state);
}

function isMessage(value: unknown): value is OpenCodeMessage {
  if (!isRecord(value) || !isRecord(value.info) || typeof value.info.role !== 'string') {
    return false;
  }
  if (value.info.error !== undefined && !isRecord(value.info.error)) return false;
  return Array.isArray(value.parts) && value.parts.every(isPart);
}

export class OpenCodeClient {
  readonly #baseUrl: string;
  readonly #authorization: string;
  readonly #timeoutMs: number;
  readonly #maxBytes: number;
  readonly #fetch: typeof fetch;

  constructor(options: OpenCodeClientOptions) {
    let url: URL;
    try {
      url = new URL(options.baseUrl);
    } catch {
      throw new AgentError('invalid_input', { field: 'base_url' });
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new AgentError('invalid_input', { field: 'base_url' });
    }
    if (options.password.length < 32) throw new AgentError('invalid_input', { field: 'session' });
    this.#baseUrl = url.toString().replace(/\/$/, '');
    const basic = Buffer.from(`${SERVER_USER}:${options.password}`, 'utf8').toString('base64');
    this.#authorization = `Basic ${basic}`;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#maxBytes = options.maxResponseBytes ?? 16 * 1024 * 1024;
    this.#fetch = options.fetch ?? fetch;
  }

  async #request(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH',
    path: string,
    body?: unknown,
    timeoutMs?: number,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: {
          authorization: this.#authorization,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs ?? this.#timeoutMs),
        redirect: 'error',
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      throw new AgentError(name === 'TimeoutError' ? 'timeout' : 'network_error');
    }
    const text = await this.#readBody(response);
    if (response.status === 401 || response.status === 403) {
      throw new AgentError('unauthorized', { status: response.status });
    }
    if (response.status === 404) throw new AgentError('not_found', { status: 404 });
    if (response.status >= 500) throw new AgentError('server_error', { status: response.status });
    if (!response.ok) throw new AgentError('invalid_response', { status: response.status });
    try {
      return text === '' ? null : (JSON.parse(text) as unknown);
    } catch {
      throw new AgentError('invalid_response', { field: 'json' });
    }
  }

  async #readBody(response: Response): Promise<string> {
    if (!response.body) return '';
    const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk: { done: boolean; value?: Uint8Array } = await reader.read();
        if (chunk.done || !chunk.value) break;
        size += chunk.value.byteLength;
        if (size > this.#maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new AgentError('invalid_response', { field: 'size' });
        }
        chunks.push(chunk.value);
      }
    } catch (error) {
      if (error instanceof AgentError) throw error;
      const name = error instanceof Error ? error.name : '';
      throw new AgentError(name === 'TimeoutError' ? 'timeout' : 'network_error');
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  /** `PUT /auth/:provider`: the run's virtual key (OpenCode keeps it in its home tmpfs, gap 2). */
  async setApiKey(provider: string, key: string): Promise<void> {
    await this.#request('PUT', `/auth/${provider}`, { type: 'api', key });
  }

  /**
   * `PATCH /global/config`. Never `PATCH /config`: that one writes `config.json` into the
   * repository (ADR-M68 §6 gap 3).
   */
  async patchGlobalConfig(body: Record<string, unknown>): Promise<void> {
    await this.#request('PATCH', '/global/config', body);
  }

  async globalConfig(): Promise<unknown> {
    return this.#request('GET', '/global/config');
  }

  /** The configuration in effect (global, the image's file and the project's merged). */
  async config(): Promise<unknown> {
    return this.#request('GET', '/config');
  }

  /** `POST /instance/dispose`: a patched configuration applies to a new instance only. */
  async disposeInstance(): Promise<void> {
    await this.#request('POST', '/instance/dispose');
  }

  async toolIds(): Promise<string[]> {
    const answer = await this.#request('GET', '/experimental/tool/ids');
    if (
      !Array.isArray(answer) ||
      !answer.every((id) => typeof id === 'string' && TOOL_ID.test(id))
    ) {
      throw new AgentError('invalid_response', { field: 'tool_ids' });
    }
    return answer as string[];
  }

  /** The IDs of every session of the server (the agent could start one of its own). */
  async sessionIds(): Promise<string[]> {
    const answer = await this.#request('GET', '/session');
    const ids = Array.isArray(answer) ? answer.map((s) => (isRecord(s) ? s.id : undefined)) : [];
    if (
      !Array.isArray(answer) ||
      !ids.every((id) => typeof id === 'string' && SESSION_ID.test(id))
    ) {
      throw new AgentError('invalid_response', { field: 'sessions' });
    }
    return ids as string[];
  }

  async createSession(): Promise<string> {
    const answer = await this.#request('POST', '/session', {});
    const id = isRecord(answer) ? answer.id : undefined;
    if (typeof id !== 'string' || !SESSION_ID.test(id)) {
      throw new AgentError('invalid_response', { field: 'id' });
    }
    return id;
  }

  async promptAsync(sessionId: string, body: Record<string, unknown>): Promise<void> {
    await this.#request('POST', `${sessionPath(sessionId)}/prompt_async`, body);
  }

  /** The state of the session; `idle` when the server does not list it (no work in flight). */
  async sessionState(sessionId: string): Promise<SessionState> {
    sessionPath(sessionId);
    const answer = await this.#request('GET', '/session/status');
    if (!isRecord(answer)) throw new AgentError('invalid_response', { field: 'session_status' });
    const entry = answer[sessionId];
    if (entry === undefined) return 'idle';
    const type = isRecord(entry) ? entry.type : undefined;
    if (typeof type !== 'string' || !SESSION_STATES.includes(type)) {
      throw new AgentError('invalid_response', { field: 'session_status' });
    }
    return type as SessionState;
  }

  async messages(sessionId: string): Promise<OpenCodeMessage[]> {
    const answer = await this.#request('GET', `${sessionPath(sessionId)}/message`);
    if (!Array.isArray(answer) || !answer.every(isMessage)) {
      throw new AgentError('invalid_response', { field: 'messages' });
    }
    return answer;
  }

  async abort(sessionId: string): Promise<void> {
    await this.#request('POST', `${sessionPath(sessionId)}/abort`);
  }

  /**
   * `POST /session/:id/shell`: runs `command` with the agent's shell and returns the output of
   * its tool part. The server evaluates the command once more, so callers send it wrapped
   * (`wrapped` in request.ts, ADR-M68 §6 gap 4).
   */
  async shell(
    sessionId: string,
    agent: string,
    command: string,
    timeoutMs?: number,
  ): Promise<string> {
    const answer = await this.#request(
      'POST',
      `${sessionPath(sessionId)}/shell`,
      { agent, command },
      timeoutMs,
    );
    if (!isMessage(answer)) throw new AgentError('invalid_response', { field: 'shell' });
    const output = answer.parts.find((part) => part.type === 'tool')?.state?.output;
    if (typeof output !== 'string') throw new AgentError('invalid_response', { field: 'shell' });
    return output;
  }
}
