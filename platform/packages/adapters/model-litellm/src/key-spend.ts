// The spend of a run's key, read with that key itself (task C07, design/ADR-M34 §2.6). The runner
// holds the run's virtual key, never the master key: `GET /key/info` without a `key` parameter
// answers for the calling key only. The adapter never sends another key's hash, so a run key
// cannot ask about another key (`pnpm test:litellm` proves LiteLLM refuses it anyway).
import type { RedactedSecret, RunKeySpendReader, SpendInfo } from '@sdlc/contracts';

import { GatewayError } from './errors.js';
import { checkBaseUrl } from './gateway.js';
import { usdFromNumber } from './mapping.js';

export interface LiteLLMKeySpendReaderOptions {
  /** For example `http://litellm:4000`. No path, no credentials. */
  readonly baseUrl: string;
  /** Per request; default 5 000 ms. */
  readonly timeoutMs?: number;
  /** For tests only. */
  readonly fetch?: typeof fetch;
}

export class LiteLLMKeySpendReader implements RunKeySpendReader {
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: LiteLLMKeySpendReaderOptions) {
    this.#baseUrl = checkBaseUrl(options.baseUrl);
    this.#timeoutMs = options.timeoutMs ?? 5_000;
    this.#fetch = options.fetch ?? fetch;
  }

  /**
   * True when LiteLLM refuses the key as unknown (401): it was revoked (task C11, ADR-M42 §2.6).
   * The runner waits for this before it reads a killed run's workspace. Any other answer or error,
   * a 403 from a proxy included: false (not confirmed; security review).
   */
  async keyRevoked(key: RedactedSecret): Promise<boolean> {
    try {
      await this.readOwnSpend(key);
      return false;
    } catch (error) {
      return error instanceof GatewayError && error.code === 'http_error' && error.status === 401;
    }
  }

  async readOwnSpend(key: RedactedSecret): Promise<SpendInfo> {
    let response: Response;
    try {
      response = await this.#fetch(new URL('/key/info', this.#baseUrl), {
        method: 'GET',
        headers: { authorization: `Bearer ${key.reveal()}` },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      // The cause is dropped on purpose: it can carry the request.
      throw new GatewayError('unreachable', 'LiteLLM GET /key/info: no answer');
    }
    const text = await response.text();
    if (!response.ok) {
      throw new GatewayError(
        'http_error',
        `LiteLLM GET /key/info: HTTP ${response.status}`,
        response.status,
      );
    }
    let answer: { info?: { spend?: unknown; max_budget?: unknown } };
    try {
      answer = JSON.parse(text) as typeof answer;
    } catch {
      throw new GatewayError('unexpected_response', 'LiteLLM GET /key/info: answer is not JSON');
    }
    const info = answer?.info;
    if (!info || typeof info !== 'object') {
      throw new GatewayError('unexpected_response', 'LiteLLM GET /key/info: no info');
    }
    return {
      spendUsd: usdFromNumber(info.spend ?? 0),
      maxBudgetUsd: info.max_budget == null ? null : usdFromNumber(info.max_budget),
    };
  }
}
