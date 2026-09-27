// Thin REST client for the OpenHands Agent Server 1.48.0 (design/ADR-M10 §2.2, ADR-M29).
// Endpoints checked against the `openapi.json` served by the pinned image.
//
// - Every call sends the per-run session key in `X-Session-API-Key`; only the runner holds it.
// - Fails closed: a status or shape it does not know is `invalid_response` (ADR-M10 §4.4).
// - Errors never carry text from the Agent Server (it can echo the model's output or the request).
import { AgentError } from '@sdlc/contracts';

export const SESSION_HEADER = 'X-Session-API-Key';

/** `ConversationExecutionStatus` of Agent Server 1.48.0. */
export const EXECUTION_STATUSES = [
  'idle',
  'running',
  'paused',
  'waiting_for_confirmation',
  'finished',
  'error',
  'stuck',
  'deleting',
] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export type AgentEventRecord = Readonly<Record<string, unknown>>;

export interface BashResult {
  readonly exitCode: number | null;
  readonly stdout: string;
}

export interface ClientOptions {
  readonly baseUrl: string;
  readonly sessionKey: string;
  /** Per request. Default 30 s. */
  readonly timeoutMs?: number;
  /** Largest response body read. Default 16 MiB. */
  readonly maxResponseBytes?: number;
  /** For tests. Default: the global `fetch`. */
  readonly fetch?: typeof fetch;
}

const UUIDISH = /^[0-9a-fA-F-]{8,64}$/;
const PAGE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const EVENT_PAGE_SIZE = 100;

function isExecutionStatus(value: unknown): value is ExecutionStatus {
  return typeof value === 'string' && (EXECUTION_STATUSES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export class AgentServerClient {
  readonly #baseUrl: string;
  readonly #sessionKey: string;
  readonly #timeoutMs: number;
  readonly #maxBytes: number;
  readonly #fetch: typeof fetch;

  constructor(options: ClientOptions) {
    let url: URL;
    try {
      url = new URL(options.baseUrl);
    } catch {
      throw new AgentError('invalid_input', { field: 'base_url' });
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new AgentError('invalid_input', { field: 'base_url' });
    }
    if (options.sessionKey.length < 32) throw new AgentError('invalid_input', { field: 'session' });
    this.#baseUrl = url.toString().replace(/\/$/, '');
    this.#sessionKey = options.sessionKey;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#maxBytes = options.maxResponseBytes ?? 16 * 1024 * 1024;
    this.#fetch = options.fetch ?? fetch;
  }

  async #request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    timeoutMs?: number,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: {
          [SESSION_HEADER]: this.#sessionKey,
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

  /**
   * Reads the body as a stream and stops at `maxResponseBytes`, so a huge answer never fills the
   * runner's memory (every run of the process shares it).
   */
  async #readBody(response: Response): Promise<string> {
    if (!response.body) return '';
    const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk: { done: boolean; value?: Uint8Array } = await reader.read();
        if (chunk.done || !chunk.value) break;
        const value = chunk.value;
        size += value.byteLength;
        if (size > this.#maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new AgentError('invalid_response', { field: 'size' });
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof AgentError) throw error;
      const name = error instanceof Error ? error.name : '';
      throw new AgentError(name === 'TimeoutError' ? 'timeout' : 'network_error');
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  /** `POST /api/conversations`. Returns the conversation ID. */
  async startConversation(body: Record<string, unknown>): Promise<string> {
    const answer = await this.#request('POST', '/api/conversations', body);
    const id = isRecord(answer) ? answer.id : undefined;
    if (typeof id !== 'string' || !UUIDISH.test(id)) {
      throw new AgentError('invalid_response', { field: 'id' });
    }
    return id;
  }

  async executionStatus(conversationId: string): Promise<ExecutionStatus> {
    const answer = await this.#request('GET', `/api/conversations/${conversation(conversationId)}`);
    const status = isRecord(answer) ? answer.execution_status : undefined;
    if (!isExecutionStatus(status)) {
      throw new AgentError('invalid_response', { field: 'execution_status' });
    }
    return status;
  }

  /** Cancels the model call in flight; the conversation becomes `paused` (ADR-M10 §2.2). */
  async interrupt(conversationId: string): Promise<void> {
    await this.#request('POST', `/api/conversations/${conversation(conversationId)}/interrupt`);
  }

  /** All events, oldest first, following `next_page_id` (at most `maxPages` pages). */
  async listEvents(conversationId: string, maxPages = 200): Promise<AgentEventRecord[]> {
    const events: AgentEventRecord[] = [];
    let pageId: string | undefined;
    for (let page = 0; page < maxPages; page += 1) {
      const query = new URLSearchParams({
        limit: String(EVENT_PAGE_SIZE),
        sort_order: 'TIMESTAMP',
        ...(pageId ? { page_id: pageId } : {}),
      });
      const answer = await this.#request(
        'GET',
        `/api/conversations/${conversation(conversationId)}/events/search?${query.toString()}`,
      );
      const items = isRecord(answer) ? answer.items : undefined;
      if (!Array.isArray(items) || !items.every(isRecord)) {
        throw new AgentError('invalid_response', { field: 'items' });
      }
      events.push(...items);
      const next = isRecord(answer) ? answer.next_page_id : undefined;
      if (next === null || next === undefined) return events;
      if (typeof next !== 'string' || !PAGE_ID.test(next)) {
        throw new AgentError('invalid_response', { field: 'next_page_id' });
      }
      pageId = next;
    }
    throw new AgentError('invalid_response', { field: 'too_many_pages' });
  }

  /** `POST /api/bash/execute_bash_command`: runs a command in the sandbox and waits for it. */
  async executeBash(command: string, cwd: string, timeoutSeconds: number): Promise<BashResult> {
    const answer = await this.#request(
      'POST',
      '/api/bash/execute_bash_command',
      { command, cwd, timeout: timeoutSeconds },
      (timeoutSeconds + 30) * 1000,
    );
    if (!isRecord(answer)) throw new AgentError('invalid_response', { field: 'bash' });
    const exitCode = answer.exit_code;
    const stdout = answer.stdout;
    if (!(exitCode === null || (typeof exitCode === 'number' && Number.isInteger(exitCode)))) {
      throw new AgentError('invalid_response', { field: 'exit_code' });
    }
    if (!(stdout === null || stdout === undefined || typeof stdout === 'string')) {
      throw new AgentError('invalid_response', { field: 'stdout' });
    }
    return { exitCode, stdout: stdout ?? '' };
  }
}

function conversation(id: string): string {
  if (!UUIDISH.test(id)) throw new AgentError('invalid_input', { field: 'conversation_id' });
  return id;
}
