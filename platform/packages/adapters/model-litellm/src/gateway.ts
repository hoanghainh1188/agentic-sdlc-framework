// LiteLLM Proxy as the platform's ModelGateway (design/D-03 section 7.4, D-07 section 3, D-08 C03,
// design/ADR-M24). Admin calls use the LiteLLM master key, which only the Cost Controller holds
// (OpenBao `kv/cost-controller/litellm-master-key`, D-03 §8.2). The sandbox only ever receives the
// per-run virtual key (D-02 FR-50).
import { inspect } from 'node:util';

import type {
  CreateRunKey,
  ModelGateway,
  ModelRef,
  RedactedSecret,
  SpendInfo,
  SpendPage,
  SpendRecord,
  TenantBudget,
  VirtualKey,
} from '@sdlc/contracts';

import { GatewayError } from './errors.js';
import {
  keyGenerateBody,
  modelsFromInfo,
  runKeyAlias,
  spendLogTime,
  spendRecordFromRow,
  teamBody,
  tenantTeamId,
  usdFromNumber,
  UUID,
} from './mapping.js';

export interface LiteLLMGatewayOptions {
  /** For example `http://litellm:4000` (Compose network). No path, no credentials. */
  readonly baseUrl: string;
  /** The LiteLLM master key, read from OpenBao by the caller. */
  readonly masterKey: RedactedSecret;
  /** Per request; default 15 000 ms. */
  readonly timeoutMs?: number;
  /** Spend rows per page; default 100. */
  readonly pageSize?: number;
  /** Pages `listSpend` reads at most (default 1000). For tests only. */
  readonly maxPages?: number;
  /** For tests only. */
  readonly fetch?: typeof fetch;
}

const HASHED_KEY = /^[0-9a-f]{64}$/;
/**
 * LiteLLM caps the number of rows it counts; paging stops there (ADR-M24 §2.2). A range with more
 * pages fails with `truncated` (C12): the worker syncs in slices.
 */
const MAX_PAGES = 1000;

/** A virtual key that does not show up in logs, errors or JSON. */
class VirtualKeySecret implements RedactedSecret {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  reveal(): string {
    return this.#value;
  }
  toString(): string {
    return '[redacted]';
  }
  toJSON(): string {
    return '[redacted]';
  }
  [inspect.custom](): string {
    return '[redacted]';
  }
}

export function checkBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GatewayError('invalid_input', 'baseUrl is not a URL', undefined, 'baseUrl');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '')
  ) {
    throw new GatewayError(
      'invalid_input',
      'baseUrl must be http(s)://host:port only',
      undefined,
      'baseUrl',
    );
  }
  return url.origin;
}

export class LiteLLMGateway implements ModelGateway {
  readonly #baseUrl: string;
  readonly #masterKey: RedactedSecret;
  readonly #timeoutMs: number;
  readonly #pageSize: number;
  readonly #maxPages: number;
  readonly #fetch: typeof fetch;

  constructor(options: LiteLLMGatewayOptions) {
    this.#baseUrl = checkBaseUrl(options.baseUrl);
    this.#masterKey = options.masterKey;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#pageSize = options.pageSize ?? 100;
    this.#maxPages = options.maxPages ?? MAX_PAGES;
    this.#fetch = options.fetch ?? fetch;
  }

  /** Sends one admin request. Returns the parsed body, or `undefined` for an allowed 404. */
  async #request(
    method: 'GET' | 'POST',
    path: string,
    options: { body?: unknown; query?: Record<string, string>; allow404?: boolean } = {},
  ): Promise<unknown> {
    const url = new URL(path, this.#baseUrl);
    for (const [name, value] of Object.entries(options.query ?? {}))
      url.searchParams.set(name, value);
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${this.#masterKey.reveal()}`,
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      // The cause is dropped on purpose: it can carry the request.
      throw new GatewayError('unreachable', `LiteLLM ${method} ${path}: no answer`);
    }
    const text = await response.text();
    // LiteLLM reports some "not found" cases as HTTP 400/500 with code "404" in the body.
    const notFound = response.status === 404 || /"code"\s*:\s*"404"/.test(text);
    if (notFound && options.allow404) return undefined;
    if (!response.ok) {
      throw new GatewayError(
        'http_error',
        `LiteLLM ${method} ${path}: HTTP ${response.status}`,
        response.status,
      );
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new GatewayError(
        'unexpected_response',
        `LiteLLM ${method} ${path}: answer is not JSON`,
      );
    }
  }

  async ensureTenantBudget(input: TenantBudget): Promise<{ readonly tenantGroupId: string }> {
    const teamId = tenantTeamId(input.tenantSlug);
    const body = teamBody(teamId, input.monthlyBudgetUsd);
    const updated = await this.#request('POST', '/team/update', { body, allow404: true });
    if (updated === undefined) await this.#request('POST', '/team/new', { body });
    return { tenantGroupId: teamId };
  }

  async createRunKey(input: CreateRunKey): Promise<VirtualKey> {
    const body = keyGenerateBody(input);
    const answer = (await this.#request('POST', '/key/generate', { body })) as {
      key?: unknown;
      token?: unknown;
      expires?: unknown;
    };
    const expires = typeof answer.expires === 'string' ? new Date(answer.expires) : undefined;
    if (
      typeof answer.key !== 'string' ||
      typeof answer.token !== 'string' ||
      !HASHED_KEY.test(answer.token) ||
      !expires ||
      Number.isNaN(expires.getTime())
    ) {
      throw new GatewayError(
        'unexpected_response',
        'LiteLLM /key/generate: key, token or expires missing',
      );
    }
    return { keyId: answer.token, key: new VirtualKeySecret(answer.key), expiresAt: expires };
  }

  async revokeKey(keyId: string): Promise<void> {
    if (!HASHED_KEY.test(keyId))
      throw new GatewayError('invalid_input', 'keyId is not a key hash', undefined, 'keyId');
    await this.#request('POST', '/key/delete', { body: { keys: [keyId] }, allow404: true });
  }

  async revokeRunKey(runId: string): Promise<void> {
    if (!UUID.test(runId))
      throw new GatewayError('invalid_input', 'runId is not a UUID', undefined, 'runId');
    // The key alias is `run-<run_id>` (keyGenerateBody); LiteLLM deletes by alias.
    await this.#request('POST', '/key/delete', {
      body: { key_aliases: [runKeyAlias(runId)] },
      allow404: true,
    });
  }

  async getSpend(keyId: string): Promise<SpendInfo> {
    if (!HASHED_KEY.test(keyId))
      throw new GatewayError('invalid_input', 'keyId is not a key hash', undefined, 'keyId');
    const answer = (await this.#request('GET', '/key/info', { query: { key: keyId } })) as {
      info?: { spend?: unknown; max_budget?: unknown };
    };
    if (!answer.info) throw new GatewayError('unexpected_response', 'LiteLLM /key/info: no info');
    return {
      spendUsd: usdFromNumber(answer.info.spend ?? 0),
      maxBudgetUsd: answer.info.max_budget == null ? null : usdFromNumber(answer.info.max_budget),
    };
  }

  async listModels(): Promise<ModelRef[]> {
    return modelsFromInfo(await this.#request('GET', '/model/info'));
  }

  async listSpend(range: { readonly from: Date; readonly to: Date }): Promise<SpendPage> {
    // The filter works on whole seconds; widen it, then keep [from, to) exactly.
    const start = new Date(Math.floor(range.from.getTime() / 1000) * 1000);
    const end = new Date(Math.ceil(range.to.getTime() / 1000) * 1000);
    const records: SpendRecord[] = [];
    let unreadable = 0;
    let complete = false;
    for (let page = 1; page <= this.#maxPages; page++) {
      const answer = (await this.#request('GET', '/spend/logs/v2', {
        query: {
          start_date: spendLogTime(start),
          end_date: spendLogTime(end),
          page: String(page),
          page_size: String(this.#pageSize),
        },
      })) as { data?: unknown; total_pages?: unknown };
      if (!Array.isArray(answer.data)) {
        throw new GatewayError('unexpected_response', 'LiteLLM /spend/logs/v2: no data list');
      }
      for (const row of answer.data as unknown[]) {
        // One row LiteLLM cannot describe (a negative cost, a missing ID) must not hide the others.
        try {
          records.push(spendRecordFromRow(row as never));
        } catch (error) {
          if (!(error instanceof GatewayError)) throw error;
          unreadable += 1;
        }
      }
      if (!Number.isInteger(answer.total_pages)) {
        throw new GatewayError('unexpected_response', 'LiteLLM /spend/logs/v2: no total_pages');
      }
      if (page >= (answer.total_pages as number)) {
        complete = true;
        break;
      }
    }
    // Never return part of the range as if it were all of it (C12): the caller retries smaller.
    if (!complete) {
      throw new GatewayError('truncated', 'LiteLLM /spend/logs/v2: more pages than the page cap');
    }
    return {
      records: records
        .filter((r) => r.occurredAt >= range.from && r.occurredAt < range.to)
        .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime()),
      unreadable,
    };
  }
}
