// D-08 C03, adapter part: `LiteLLMGateway` against an in-process LiteLLM stand-in.
// AC2: per-run key with cost cap, model list and the seven labels (also as tags on every call).
// AC3: revoke. AC4: spend rows mapped to records. Also: tenant team with a monthly budget (FR-51),
// model list with provider types (QUESTIONS #17), and no secret or LiteLLM text in errors.
import { inspect } from 'node:util';

import {
  GatewayError,
  labelsFromTags,
  labelTags,
  LiteLLMGateway,
  spendRecordFromRow,
  usdFromNumber,
} from '@sdlc/adapter-model-litellm';
import { COST_LABEL_NAMES, type CostLabels, type CreateRunKey } from '@sdlc/contracts';
import { Redacted } from '@sdlc/secrets';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ECHO_MARKER, MASTER_KEY, StubLiteLLM } from './stub-litellm.js';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const HASH = 'a'.repeat(64);
const LABELS: CostLabels = {
  tenant: 'acme',
  project: 'pilot-order-inventory',
  intent_id: 'INT-2026-0001',
  run_id: RUN_ID,
  gate: 'G4',
  agent: 'coder-openhands',
  data_class: 'internal',
};
const KEY_INPUT: CreateRunKey = {
  runId: RUN_ID,
  labels: LABELS,
  maxBudgetUsd: '0.5',
  models: ['claude-haiku-4-5'],
  durationMinutes: 75,
  tenantGroupId: 'sdlc-tenant-acme',
};

let stub: StubLiteLLM;
let gateway: LiteLLMGateway;

beforeAll(async () => {
  stub = await StubLiteLLM.start();
  gateway = new LiteLLMGateway({ baseUrl: stub.url, masterKey: new Redacted(MASTER_KEY) });
});
afterAll(() => stub.close());
beforeEach(() => stub.reset());

/** Runs `work` and returns the error, checking it carries nothing from LiteLLM or a key. */
async function failure(work: () => Promise<unknown>): Promise<GatewayError> {
  const error = await work().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(GatewayError);
  const text = `${String(error)} ${(error as Error).stack} ${inspect(error)} ${JSON.stringify(error)}`;
  expect(text).not.toContain(ECHO_MARKER);
  expect(text).not.toContain(MASTER_KEY);
  return error as GatewayError;
}

describe('AC2: createRunKey', () => {
  it('sends the cap, models, lifetime, team and the seven labels as metadata and tags', async () => {
    stub.on('POST', '/key/generate', () => ({
      body: { key: 'sk-virtual-XYZ', token: HASH, expires: '2026-09-26T10:15:00Z' },
    }));
    const key = await gateway.createRunKey(KEY_INPUT);
    expect(key.keyId).toBe(HASH);
    expect(key.expiresAt.toISOString()).toBe('2026-09-26T10:15:00.000Z');
    expect(stub.requests[0]!.body).toEqual({
      key_alias: `run-${RUN_ID}`,
      team_id: 'sdlc-tenant-acme',
      models: ['claude-haiku-4-5'],
      max_budget: 0.5,
      duration: '75m',
      metadata: { ...LABELS, tags: COST_LABEL_NAMES.map((n) => `${n}:${LABELS[n]}`) },
    });
  });

  it('never shows the virtual key in logs or JSON; reveal() gives it', async () => {
    stub.on('POST', '/key/generate', () => ({
      body: { key: 'sk-virtual-SECRET', token: HASH, expires: '2026-09-26T10:15:00Z' },
    }));
    const key = await gateway.createRunKey(KEY_INPUT);
    for (const shown of [inspect(key.key), JSON.stringify(key), inspect(key), `${inspect(key)}`]) {
      expect(shown).not.toContain('sk-virtual-SECRET');
    }
    expect(key.key.reveal()).toBe('sk-virtual-SECRET');
  });

  it.each([
    ['a label is missing', { labels: { ...LABELS, agent: '' } }, 'labels'],
    ['a label is free text', { labels: { ...LABELS, project: 'my project' } }, 'labels'],
    ['a label is an e-mail address', { labels: { ...LABELS, agent: 'a@b.jp' } }, 'labels'],
    ['run_id label differs', { labels: { ...LABELS, run_id: HASH.slice(0, 36) } }, 'labels'],
    ['no model', { models: [] }, 'models'],
    ['budget 0', { maxBudgetUsd: '0' }, 'maxBudgetUsd'],
    ['budget as float text', { maxBudgetUsd: '1e-3' }, 'maxBudgetUsd'],
    ['duration 0', { durationMinutes: 0 }, 'durationMinutes'],
    ['duration above a day', { durationMinutes: 24 * 60 + 1 }, 'durationMinutes'],
  ] as const)('refuses before calling LiteLLM when %s', async (_, change, field) => {
    const error = await failure(() => gateway.createRunKey({ ...KEY_INPUT, ...change }));
    expect([error.code, error.field]).toEqual(['invalid_input', field]);
    expect(stub.requests).toEqual([]);
  });

  it('refuses an answer without key, token or expiry', async () => {
    stub.on('POST', '/key/generate', () => ({ body: { key: 'sk-x' } }));
    expect((await failure(() => gateway.createRunKey(KEY_INPUT))).code).toBe('unexpected_response');
  });

  it('HTTP errors carry the status, never the LiteLLM text', async () => {
    stub.on('POST', '/key/generate', () => ({
      status: 500,
      body: { error: { message: `boom ${ECHO_MARKER} ${MASTER_KEY}` } },
    }));
    const error = await failure(() => gateway.createRunKey(KEY_INPUT));
    expect([error.code, error.status]).toEqual(['http_error', 500]);
  });

  it('a wrong master key is an HTTP error', async () => {
    const other = new LiteLLMGateway({ baseUrl: stub.url, masterKey: new Redacted('sk-wrong') });
    expect((await failure(() => other.createRunKey(KEY_INPUT))).status).toBe(401);
  });

  it('an unreachable LiteLLM is reported as such', async () => {
    const down = new LiteLLMGateway({
      baseUrl: 'http://127.0.0.1:9',
      masterKey: new Redacted(MASTER_KEY),
      timeoutMs: 2000,
    });
    expect((await failure(() => down.createRunKey(KEY_INPUT))).code).toBe('unreachable');
  });
});

describe('AC3: revokeKey', () => {
  it('deletes the key by its hash', async () => {
    stub.on('POST', '/key/delete', () => ({ body: { deleted_keys: [HASH] } }));
    await gateway.revokeKey(HASH);
    expect(stub.requests[0]!.body).toEqual({ keys: [HASH] });
  });

  it('a key that is already gone is not an error (LiteLLM reports code "404" in a 500)', async () => {
    stub.on('POST', '/key/delete', () => ({
      status: 500,
      body: { error: { message: "{'error': 'No keys found'}", code: '404' } },
    }));
    await expect(gateway.revokeKey(HASH)).resolves.toBeUndefined();
  });

  it('refuses anything that is not a key hash (never sends a raw key)', async () => {
    expect((await failure(() => gateway.revokeKey('sk-raw-key'))).code).toBe('invalid_input');
    expect(stub.requests).toEqual([]);
  });
});

describe('FR-51: ensureTenantBudget (tenant team, UTC calendar month)', () => {
  it('updates the team with a fixed ID and a monthly budget', async () => {
    stub.on('POST', '/team/update', () => ({ body: { team_id: 'sdlc-tenant-acme' } }));
    expect(
      await gateway.ensureTenantBudget({ tenantSlug: 'acme', monthlyBudgetUsd: '100' }),
    ).toEqual({
      tenantGroupId: 'sdlc-tenant-acme',
    });
    expect(stub.requests.map((r) => [r.path, r.body])).toEqual([
      [
        '/team/update',
        {
          team_id: 'sdlc-tenant-acme',
          team_alias: 'sdlc-tenant-acme',
          max_budget: 100,
          budget_duration: '1mo',
        },
      ],
    ]);
  });

  it('creates the team when it does not exist yet; null budget = no cap', async () => {
    stub.on('POST', '/team/update', () => ({ status: 404, body: { error: { code: '404' } } }));
    stub.on('POST', '/team/new', () => ({ body: { team_id: 'sdlc-tenant-acme' } }));
    await gateway.ensureTenantBudget({ tenantSlug: 'acme', monthlyBudgetUsd: null });
    expect(stub.requests.map((r) => r.path)).toEqual(['/team/update', '/team/new']);
    expect((stub.requests[1]!.body as { max_budget: unknown }).max_budget).toBeNull();
  });

  it('refuses a slug that is not a slug', async () => {
    const error = await failure(() =>
      gateway.ensureTenantBudget({ tenantSlug: '../x', monthlyBudgetUsd: null }),
    );
    expect(error.field).toBe('tenantSlug');
  });
});

describe('getSpend and listModels', () => {
  it('reads the spend of a key as a 6-decimal string', async () => {
    stub.on('GET', '/key/info', (r) => {
      expect(r.query.get('key')).toBe(HASH);
      return { body: { info: { spend: 0.0012000000000000001, max_budget: 0.003 } } };
    });
    expect(await gateway.getSpend(HASH)).toEqual({ spendUsd: '0.0012', maxBudgetUsd: '0.003' });
  });

  it('lists models with their provider type; models without one are left out', async () => {
    stub.on('GET', '/model/info', () => ({
      body: {
        data: [
          { model_name: 'claude-haiku-4-5', model_info: { provider_type: 'api' } },
          { model_name: 'local-qwen', model_info: { provider_type: 'self_hosted' } },
          { model_name: 'no-type', model_info: {} },
          { model_name: 'wrong-type', model_info: { provider_type: 'cloud' } },
        ],
      },
    }));
    expect(await gateway.listModels()).toEqual([
      { model: 'claude-haiku-4-5', providerType: 'api' },
      { model: 'local-qwen', providerType: 'self_hosted' },
    ]);
  });
});

describe('AC4: listSpend', () => {
  const row = (id: string, startTime: string, extra: Record<string, unknown> = {}) => ({
    request_id: id,
    model: 'anthropic/claude-haiku-4-5-20251001',
    model_group: 'claude-haiku-4-5',
    status: 'success',
    spend: 0.001,
    prompt_tokens: 1000,
    completion_tokens: 100,
    startTime,
    request_tags: [...labelTags(LABELS), 'User-Agent: curl'],
    metadata: { usage_object: { prompt_tokens_details: { cached_tokens: 200 } } },
    ...extra,
  });

  it('pages through /spend/logs/v2 with UTC second filters and keeps [from, to) only', async () => {
    stub.on('GET', '/spend/logs/v2', (r) => {
      const page = Number(r.query.get('page'));
      return {
        body: {
          data:
            page === 1
              ? [
                  row('r-2', '2026-09-26T08:00:05.500+00:00'),
                  row('r-early', '2026-09-26T07:59:59.900+00:00'),
                ]
              : [
                  row('r-1', '2026-09-26T08:00:01.000+00:00'),
                  row('r-late', '2026-09-26T08:00:10.200+00:00'),
                ],
          total_pages: 2,
        },
      };
    });
    const { records, unreadable } = await gateway.listSpend({
      from: new Date('2026-09-26T08:00:00.250Z'),
      to: new Date('2026-09-26T08:00:10.100Z'),
    });
    expect(unreadable).toBe(0);
    expect(records.map((r) => r.sourceRef)).toEqual(['r-1', 'r-2']);
    expect(
      stub.requests.map((r) => [
        r.query.get('start_date'),
        r.query.get('end_date'),
        r.query.get('page'),
      ]),
    ).toEqual([
      ['2026-09-26 08:00:00', '2026-09-26 08:00:11', '1'],
      ['2026-09-26 08:00:00', '2026-09-26 08:00:11', '2'],
    ]);
    expect(records[0]).toEqual({
      sourceRef: 'r-1',
      model: 'claude-haiku-4-5',
      status: 'success',
      inputTokens: 1000,
      outputTokens: 100,
      cachedInputTokens: 200,
      costUsd: '0.001',
      occurredAt: new Date('2026-09-26T08:00:01.000Z'),
      labels: LABELS,
    });
  });

  it('refuses an answer that is not the expected shape', async () => {
    stub.on('GET', '/spend/logs/v2', () => ({ body: { rows: [] } }));
    const error = await failure(() => gateway.listSpend({ from: new Date(0), to: new Date() }));
    expect(error.code).toBe('unexpected_response');
  });

  it('refuses an answer without total_pages instead of stopping after page 1', async () => {
    stub.on('GET', '/spend/logs/v2', () => ({
      body: { data: [row('r-1', '2026-09-26T08:00:01.000+00:00')] },
    }));
    const error = await failure(() => gateway.listSpend({ from: new Date(0), to: new Date() }));
    expect(error.code).toBe('unexpected_response');
  });

  it('counts rows it cannot read, and still returns the others', async () => {
    stub.on('GET', '/spend/logs/v2', () => ({
      body: {
        data: [
          row('bad-cost', '2026-09-26T08:00:01.000+00:00', { spend: -0.5 }),
          row('ok', '2026-09-26T08:00:02.000+00:00'),
          { spend: 0.1, startTime: '2026-09-26T08:00:03.000+00:00' },
        ],
        total_pages: 1,
      },
    }));
    const page = await gateway.listSpend({
      from: new Date('2026-09-26T08:00:00Z'),
      to: new Date('2026-09-26T09:00:00Z'),
    });
    expect([page.records.map((r) => r.sourceRef), page.unreadable]).toEqual([['ok'], 2]);
  });
});

describe('mapping helpers', () => {
  it('reads our labels back from tags and ignores other tags and bad values', () => {
    expect(labelsFromTags(labelTags(LABELS))).toEqual(LABELS);
    expect(
      labelsFromTags([
        'User-Agent: curl/8',
        'tenant:acme',
        'agent:has space',
        'project:x@y',
        42,
        'color:red',
      ]),
    ).toEqual({ tenant: 'acme' });
    expect(labelsFromTags(undefined)).toEqual({});
  });

  it('keeps 6 decimals of a float spend and refuses negative or non-numbers', () => {
    expect(usdFromNumber(0.0012000000000000001)).toBe('0.0012');
    expect(usdFromNumber(0.0000004)).toBe('0');
    expect(usdFromNumber(12)).toBe('12');
    expect(() => usdFromNumber(-1)).toThrow(GatewayError);
    expect(() => usdFromNumber('abc')).toThrow(GatewayError);
  });

  it('a failed call keeps its status; the model falls back to `model` without a group', () => {
    const r = spendRecordFromRow({
      request_id: 'f-1',
      model: 'claude-haiku-4-5',
      model_group: '',
      status: 'failure',
      spend: 0,
      startTime: '2026-09-26T08:00:00Z',
    });
    expect([r.status, r.model, r.inputTokens, r.cachedInputTokens, r.costUsd]).toEqual([
      'failure',
      'claude-haiku-4-5',
      0,
      0,
      '0',
    ]);
  });

  it('cached tokens never exceed input tokens', () => {
    const r = spendRecordFromRow({
      request_id: 'c-1',
      model_group: 'm',
      prompt_tokens: 10,
      startTime: '2026-09-26T08:00:00Z',
      metadata: { usage_object: { prompt_tokens_details: { cached_tokens: 50 } } },
    });
    expect(r.cachedInputTokens).toBe(10);
  });

  it('refuses a base URL with a path, query or credentials', () => {
    for (const baseUrl of ['http://litellm:4000/v1', 'http://u:p@litellm:4000', 'ftp://x', 'x']) {
      expect(() => new LiteLLMGateway({ baseUrl, masterKey: new Redacted(MASTER_KEY) })).toThrow(
        GatewayError,
      );
    }
  });
});
