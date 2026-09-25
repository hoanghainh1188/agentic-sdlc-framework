// Per-run LiteLLM virtual keys (C01 spike, de-risks C03). Uses the LiteLLM master key, which only
// the platform side holds. The sandbox receives the virtual key only (D-02 FR-50, D-07 §3).

/** The seven labels D-07 §5 requires on every model call. */
export interface CostLabels {
  tenant: string;
  project: string;
  intent_id: string;
  run_id: string;
  gate: string;
  agent: string;
  data_class: string;
}

export const COST_LABEL_NAMES: readonly (keyof CostLabels)[] = [
  'tenant',
  'project',
  'intent_id',
  'run_id',
  'gate',
  'agent',
  'data_class',
];

export interface RunKeyRequest {
  labels: CostLabels;
  models: string[];
  maxBudgetUsd: number;
  durationMinutes: number;
}

export interface KeyInfo {
  spend: number;
  maxBudget: number | null;
  metadata: Record<string, unknown>;
  models: string[];
}

export interface SpendLog {
  model?: string;
  spend?: number;
  api_key?: string;
  metadata?: Record<string, unknown>;
  request_tags?: unknown;
}

/** Body of `POST /key/generate`. Pure, so tests can check caps and labels. */
export function buildKeyRequest(input: RunKeyRequest): Record<string, unknown> {
  return {
    key_alias: `run-${input.labels.run_id}`,
    models: input.models,
    max_budget: input.maxBudgetUsd,
    duration: `${input.durationMinutes}m`,
    metadata: { ...input.labels },
  };
}

export class LiteLlmAdmin {
  constructor(
    private readonly baseUrl: string,
    private readonly masterKey: string,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.masterKey}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    // Error bodies from LiteLLM never contain the master key; they may name a key by its last chars.
    if (!response.ok)
      throw new Error(`LiteLLM ${path} returned HTTP ${response.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as T;
  }

  async createRunKey(input: RunKeyRequest): Promise<string> {
    const result = await this.request<{ key: string }>(
      'POST',
      '/key/generate',
      buildKeyRequest(input),
    );
    return result.key;
  }

  async keyInfo(key: string): Promise<KeyInfo> {
    const { info } = await this.request<{ info: Record<string, unknown> }>(
      'GET',
      `/key/info?${new URLSearchParams({ key }).toString()}`,
    );
    return {
      spend: Number(info['spend'] ?? 0),
      maxBudget: info['max_budget'] == null ? null : Number(info['max_budget']),
      metadata: (info['metadata'] ?? {}) as Record<string, unknown>,
      models: (info['models'] ?? []) as string[],
    };
  }

  async deleteKey(key: string): Promise<void> {
    await this.request('POST', '/key/delete', { keys: [key] });
  }

  /** Spend log rows for one key. LiteLLM writes them in batches, so callers poll. */
  spendLogs(key: string): Promise<SpendLog[]> {
    return this.request('GET', `/spend/logs?${new URLSearchParams({ api_key: key }).toString()}`);
  }
}
