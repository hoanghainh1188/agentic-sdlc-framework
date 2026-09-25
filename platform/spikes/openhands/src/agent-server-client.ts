// Thin REST client for the OpenHands Agent Server v1.48.0 (C01 spike, design/ADR-M10).
// Endpoints checked against openapi.json of the v1.48.0 release and the router sources.
// Every call sends the per-run session key in `X-Session-API-Key` (dependencies.py).

import { isExecutionStatus, type ExecutionStatus } from './status-map.ts';

export const SESSION_HEADER = 'X-Session-API-Key';

/** Tools the PoC agent gets. Browser and delegation tools are left out on purpose. */
export const POC_TOOLS = ['terminal', 'file_editor', 'task_tracker'] as const;

export interface LlmSettings {
  /** LiteLLM model alias, sent as `litellm_proxy/<alias>` so OpenHands talks to the proxy. */
  modelAlias: string;
  /** LiteLLM base URL as seen from inside the sandbox. */
  baseUrl: string;
  /** Per-run LiteLLM virtual key. Never a provider key (D-02 FR-50). */
  virtualKey: string;
  /** Label for OpenHands' own usage metrics. */
  usageId: string;
}

export interface StartRequestInput {
  llm: LlmSettings;
  workingDir: string;
  task: string;
  maxIterations: number;
  /** Trace metadata; the PoC sends the D-07 labels (scalars only). */
  labels: Record<string, string>;
  /** OpenHands' built-in stuck detector (fixed thresholds). The platform runs its own check too. */
  stuckDetection: boolean;
}

export interface GitChange {
  path: string;
  status: 'MOVED' | 'ADDED' | 'DELETED' | 'UPDATED';
}

export interface GitCommit {
  sha: string;
  short_sha: string;
  subject: string;
  author: string;
  timestamp: string;
}

export interface BashOutput {
  exit_code: number | null;
  stdout?: string | null;
  stderr?: string | null;
}

export interface ConversationSummary {
  id: string;
  executionStatus: ExecutionStatus;
  raw: Record<string, unknown>;
}

export type AgentEvent = Record<string, unknown> & { kind?: string; id?: string };

export class AgentServerError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    detail: string,
  ) {
    super(`Agent Server ${path} returned HTTP ${status}: ${detail.slice(0, 300)}`);
  }
}

/** Body of `POST /api/conversations`. Pure, so tests can check what reaches the sandbox. */
export function buildStartConversationBody(input: StartRequestInput): Record<string, unknown> {
  return {
    agent: {
      kind: 'Agent',
      llm: {
        model: `litellm_proxy/${input.llm.modelAlias}`,
        base_url: input.llm.baseUrl,
        api_key: input.llm.virtualKey,
        usage_id: input.llm.usageId,
      },
      tools: POC_TOOLS.map((name) => ({ name, params: {} })),
    },
    workspace: { kind: 'LocalWorkspace', working_dir: input.workingDir },
    initial_message: { role: 'user', content: [{ type: 'text', text: input.task }], run: true },
    max_iterations: input.maxIterations,
    stuck_detection: input.stuckDetection,
    // Autotitle makes one extra model call per conversation (measured in C01): not needed.
    autotitle: false,
    observability_metadata: input.labels,
  };
}

export class AgentServerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly sessionKey: string,
    private readonly timeoutMs = 30_000,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        [SESSION_HEADER]: this.sessionKey,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) throw new AgentServerError(response.status, path, text);
    return (text ? JSON.parse(text) : null) as T;
  }

  async isReady(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/ready`, { signal: AbortSignal.timeout(3_000) });
      return response.ok;
    } catch {
      return false;
    }
  }

  serverInfo(): Promise<Record<string, unknown>> {
    return this.request('GET', '/server_info');
  }

  async startConversation(input: StartRequestInput): Promise<ConversationSummary> {
    const raw = await this.request<Record<string, unknown>>(
      'POST',
      '/api/conversations',
      buildStartConversationBody(input),
    );
    return summarise(raw);
  }

  async getConversation(id: string): Promise<ConversationSummary> {
    return summarise(await this.request('GET', `/api/conversations/${id}`));
  }

  /** Cancels the in-flight LLM call at once; the conversation becomes `paused`. */
  async interrupt(id: string): Promise<void> {
    await this.request('POST', `/api/conversations/${id}/interrupt`);
  }

  async pause(id: string): Promise<void> {
    await this.request('POST', `/api/conversations/${id}/pause`);
  }

  /** All events of a conversation, oldest first, following `next_page_id`. */
  async listEvents(id: string, maxPages = 50): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    let pageId: string | null = null;
    for (let page = 0; page < maxPages; page += 1) {
      const query = new URLSearchParams({ limit: '100', sort_order: 'TIMESTAMP' });
      if (pageId) query.set('page_id', pageId);
      const result = await this.request<{ items: AgentEvent[]; next_page_id?: string | null }>(
        'GET',
        `/api/conversations/${id}/events/search?${query.toString()}`,
      );
      events.push(...result.items);
      pageId = result.next_page_id ?? null;
      if (!pageId) break;
    }
    return events;
  }

  gitChanges(path: string): Promise<GitChange[]> {
    return this.request('GET', `/api/git/changes?${new URLSearchParams({ path }).toString()}`);
  }

  async gitCommits(path: string, limit = 5): Promise<GitCommit[]> {
    const query = new URLSearchParams({ path, limit: String(limit) });
    const page = await this.request<{ commits: GitCommit[] }>(
      'GET',
      `/api/git/commits?${query.toString()}`,
    );
    return page.commits;
  }

  executeBash(command: string, cwd: string, timeoutSeconds = 60): Promise<BashOutput> {
    return this.request('POST', '/api/bash/execute_bash_command', {
      command,
      cwd,
      timeout: timeoutSeconds,
    });
  }
}

function summarise(raw: Record<string, unknown>): ConversationSummary {
  const status = raw['execution_status'];
  if (typeof raw['id'] !== 'string' || !isExecutionStatus(status)) {
    throw new Error('Agent Server returned a conversation without id or known execution_status');
  }
  return { id: raw['id'], executionStatus: status, raw };
}
