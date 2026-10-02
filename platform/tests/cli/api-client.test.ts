// The CLI's HTTP client against a real local HTTP server (B04, design/ADR-M36 §2.3, §2.5):
// headers, redirects refused (the token never reaches another host), time-out, size cap,
// malformed answers, and the exit code of each failure.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiCallError, ApiClient, MAX_RESPONSE_BYTES } from '../../apps/cli/src/api/client.js';
import { exitCodeOf } from '../../apps/cli/src/api/errors.js';
import { escalationListSchema } from '../../apps/cli/src/api/schemas.js';
import { EXIT } from '../../apps/cli/src/index.js';
import { TOKEN } from './harness.js';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let api: Server;
let other: Server;
let apiUrl: string;
let otherUrl: string;
let handler: Handler = (_req, res) => res.end();
const otherHits: IncomingMessage[] = [];

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

beforeAll(async () => {
  api = createServer((req, res) => handler(req, res));
  other = createServer((req, res) => {
    otherHits.push(req);
    res.end('{}');
  });
  apiUrl = await listen(api);
  otherUrl = await listen(other);
});

afterAll(async () => {
  api.closeAllConnections();
  other.closeAllConnections();
  await Promise.all([api, other].map((s) => new Promise((r) => s.close(r))));
});

// Any small schema of the CLI will do: `{ items: [] }`.
const okSchema = escalationListSchema;

function client(timeoutMs?: number): ApiClient {
  return new ApiClient({
    apiUrl,
    token: TOKEN,
    fetch: globalThis.fetch,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

async function failure(promise: Promise<unknown>): Promise<ApiCallError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiCallError) return error;
    throw error;
  }
  throw new Error('expected a failure');
}

describe('ApiClient', () => {
  it('sends the bearer token, JSON and the locale, and validates the answer', async () => {
    let seen: IncomingMessage | undefined;
    let body = '';
    handler = (req, res) => {
      seen = req;
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => res.end(JSON.stringify({ items: [], extra: 'dropped' })));
    };
    expect(await client().post('/v1/x', okSchema, { a: 1 })).toEqual({ items: [] });
    expect(seen?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(seen?.headers['content-type']).toBe('application/json');
    expect(seen?.headers['accept-language']).toBe('en');
    expect(JSON.parse(body)).toEqual({ a: 1 });
  });

  it('puts query values in the URL and leaves out undefined ones', async () => {
    let url = '';
    handler = (req, res) => {
      url = req.url ?? '';
      res.end('{"items":[]}');
    };
    await client().get('/v1/x', okSchema, { project: 'pilot', status: undefined, limit: 5 });
    expect(url).toBe('/v1/x?project=pilot&limit=5');
  });

  it.each([301, 302, 307, 308])(
    'refuses a %i redirect and never calls the other host',
    async (s) => {
      handler = (_req, res) => {
        res.statusCode = s;
        res.setHeader('location', `${otherUrl}/steal`);
        res.end();
      };
      const error = await failure(client().get('/v1/x', okSchema));
      expect(error.kind).toBe('redirect');
      expect(otherHits).toEqual([]);
      expect(exitCodeOf(error)).toBe(EXIT.error);
    },
  );

  it('times out', async () => {
    handler = () => undefined; // never answers
    const error = await failure(client(200).get('/v1/x', okSchema));
    expect(error.kind).toBe('timeout');
  });

  it('refuses an answer above the size cap', async () => {
    handler = (_req, res) => {
      res.end(`"${'x'.repeat(MAX_RESPONSE_BYTES + 10)}"`);
    };
    expect((await failure(client().get('/v1/x', okSchema))).kind).toBe('too_large');
  });

  it.each([
    ['not json', 'malformed'],
    ['{"items":"x"}', 'malformed'],
  ])('refuses the answer %s', async (text, kind) => {
    handler = (_req, res) => res.end(text);
    expect((await failure(client().get('/v1/x', okSchema))).kind).toBe(kind);
  });

  it('reports a network failure without the token', async () => {
    const error = await failure(
      new ApiClient({ apiUrl: 'http://127.0.0.1:1', token: TOKEN, fetch: globalThis.fetch }).get(
        '/v1/x',
        okSchema,
      ),
    );
    expect(error.kind).toBe('network');
    expect(String(error) + JSON.stringify(error)).not.toContain(TOKEN);
  });

  it('keeps the error envelope of an error status', async () => {
    handler = (_req, res) => {
      res.statusCode = 422;
      res.end(
        JSON.stringify({ error: { code: 'approval_refused', message: 'm', reason: 'producer' } }),
      );
    };
    const error = await failure(client().get('/v1/x', okSchema));
    expect(error).toMatchObject({ kind: 'http', status: 422 });
    expect(error.envelope?.error.reason).toBe('producer');
  });
});

describe('exit codes (ADR-M36 §2.5)', () => {
  it.each([
    [401, EXIT.auth],
    [400, EXIT.usage],
    [403, EXIT.failed],
    [404, EXIT.failed],
    [409, EXIT.failed],
    [422, EXIT.failed],
    [429, EXIT.failed],
    [500, EXIT.error],
    [503, EXIT.error],
  ])('HTTP %i → %i', (status, exit) => {
    expect(exitCodeOf(new ApiCallError('http', status))).toBe(exit);
  });

  it.each(['network', 'timeout', 'redirect', 'too_large', 'malformed'] as const)(
    '%s → 3',
    (kind) => {
      expect(exitCodeOf(new ApiCallError(kind))).toBe(EXIT.error);
    },
  );
});
