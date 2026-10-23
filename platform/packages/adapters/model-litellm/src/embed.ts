// Embeddings with a run's own virtual key (task X04 PR 3a, design/ADR-M89 §2.3): `POST
// /v1/embeddings` on LiteLLM, so the key's labels make the cost count for the run (R027). Neither
// the texts nor the key ever reach an error message or a log: errors carry the method, the path
// and the status only.
import type { RedactedSecret, RunKeyEmbedder } from '@sdlc/contracts';

import { GatewayError } from './errors.js';
import { checkBaseUrl } from './gateway.js';

export interface LiteLLMEmbedderOptions {
  /** For example `http://litellm:4000`. No path, no credentials. */
  readonly baseUrl: string;
  /** Per request; default 120 000 ms (a CPU model is slow). */
  readonly timeoutMs?: number;
  /** For tests only. */
  readonly fetch?: typeof fetch;
}

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;

export class LiteLLMEmbedder implements RunKeyEmbedder {
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: LiteLLMEmbedderOptions) {
    this.#baseUrl = checkBaseUrl(options.baseUrl);
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    this.#fetch = options.fetch ?? fetch;
  }

  async embed(key: RedactedSecret, model: string, inputs: readonly string[]): Promise<number[][]> {
    if (!MODEL.test(model)) {
      throw new GatewayError('invalid_input', 'embeddings: model', undefined, 'model');
    }
    if (inputs.length === 0) return [];
    let response: Response;
    try {
      response = await this.#fetch(new URL('/v1/embeddings', this.#baseUrl), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key.reveal()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model, input: inputs }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw new GatewayError('unreachable', 'LiteLLM POST /v1/embeddings: no answer');
    }
    const text = await response.text();
    if (!response.ok) {
      throw new GatewayError(
        'http_error',
        `LiteLLM POST /v1/embeddings: HTTP ${response.status}`,
        response.status,
      );
    }
    let answer: { data?: { index?: unknown; embedding?: unknown }[] };
    try {
      answer = JSON.parse(text) as typeof answer;
    } catch {
      throw new GatewayError('unexpected_response', 'LiteLLM POST /v1/embeddings: not JSON');
    }
    const rows = Array.isArray(answer.data) ? answer.data : [];
    // Filled, not sparse: `some` and `every` skip the holes of a sparse array.
    const vectors: (number[] | undefined)[] = Array.from(
      { length: inputs.length },
      () => undefined,
    );
    for (const row of rows) {
      const index = row.index;
      const embedding = row.embedding;
      if (
        typeof index !== 'number' ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= inputs.length ||
        !Array.isArray(embedding) ||
        embedding.length === 0 ||
        !embedding.every((v) => typeof v === 'number' && Number.isFinite(v)) ||
        vectors[index] !== undefined
      ) {
        throw new GatewayError('unexpected_response', 'LiteLLM POST /v1/embeddings: bad row');
      }
      vectors[index] = embedding as number[];
    }
    if (vectors.some((v) => v === undefined) || rows.length !== inputs.length) {
      throw new GatewayError('unexpected_response', 'LiteLLM POST /v1/embeddings: missing rows');
    }
    const filled = vectors as number[][];
    if (filled.some((v) => v.length !== filled[0]!.length)) {
      throw new GatewayError('unexpected_response', 'LiteLLM POST /v1/embeddings: mixed sizes');
    }
    return filled;
  }
}
