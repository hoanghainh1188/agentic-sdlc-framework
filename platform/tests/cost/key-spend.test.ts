// C07 (ADR-M34 §2.6): the runner reads the spend of a run's key with that key itself. The reader
// sends the key as the bearer and never a `key` parameter, so it can only ask about its own key;
// errors carry nothing from LiteLLM and never the key.
import { inspect } from 'node:util';

import { GatewayError, LiteLLMKeySpendReader } from '@sdlc/adapter-model-litellm';
import { Redacted } from '@sdlc/secrets';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ECHO_MARKER, StubLiteLLM } from './stub-litellm.js';

const RUN_KEY = 'sk-run-KEY-MARKER-abcdef';

let stub: StubLiteLLM;
let reader: LiteLLMKeySpendReader;

beforeAll(async () => {
  stub = await StubLiteLLM.start();
  reader = new LiteLLMKeySpendReader({ baseUrl: stub.url });
});
afterAll(() => stub.close());
beforeEach(() => {
  stub.reset();
  stub.allowKey(RUN_KEY);
});

async function failure(work: () => Promise<unknown>): Promise<GatewayError> {
  const error = await work().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(GatewayError);
  const text = `${String(error)} ${(error as Error).stack} ${inspect(error)} ${JSON.stringify(error)}`;
  expect(text).not.toContain(ECHO_MARKER);
  expect(text).not.toContain(RUN_KEY);
  return error as GatewayError;
}

describe('LiteLLMKeySpendReader (C07)', () => {
  it('asks for the calling key only: the run key as bearer, no key parameter', async () => {
    stub.on('GET', '/key/info', () => ({
      body: { key: 'a'.repeat(64), info: { spend: 0.0412000001, max_budget: 0.5 } },
    }));
    await expect(reader.readOwnSpend(new Redacted(RUN_KEY))).resolves.toEqual({
      spendUsd: '0.0412',
      maxBudgetUsd: '0.5',
    });
    const [request] = stub.requests;
    expect(request?.authorization).toBe(`Bearer ${RUN_KEY}`);
    expect([...request!.query.keys()]).toEqual([]);
  });

  it('reads a key without a cap as maxBudgetUsd null', async () => {
    stub.on('GET', '/key/info', () => ({ body: { info: { spend: 0 } } }));
    await expect(reader.readOwnSpend(new Redacted(RUN_KEY))).resolves.toEqual({
      spendUsd: '0',
      maxBudgetUsd: null,
    });
  });

  it('maps an HTTP error without LiteLLM text or the key', async () => {
    stub.on('GET', '/key/info', () => ({ status: 401, body: { error: ECHO_MARKER } }));
    const error = await failure(() => reader.readOwnSpend(new Redacted(RUN_KEY)));
    expect(error).toMatchObject({ code: 'http_error', status: 401 });
  });

  it('refuses an answer without info', async () => {
    stub.on('GET', '/key/info', () => ({ body: { detail: ECHO_MARKER } }));
    const error = await failure(() => reader.readOwnSpend(new Redacted(RUN_KEY)));
    expect(error.code).toBe('unexpected_response');
  });

  it('reports an unreachable gateway', async () => {
    const closed = new LiteLLMKeySpendReader({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 500 });
    const error = await failure(() => closed.readOwnSpend(new Redacted(RUN_KEY)));
    expect(error.code).toBe('unreachable');
  });

  it('refuses a base URL with a path or credentials', () => {
    expect(() => new LiteLLMKeySpendReader({ baseUrl: 'http://u:p@litellm:4000' })).toThrow(
      GatewayError,
    );
    expect(() => new LiteLLMKeySpendReader({ baseUrl: 'http://litellm:4000/v1' })).toThrow(
      GatewayError,
    );
  });
});
