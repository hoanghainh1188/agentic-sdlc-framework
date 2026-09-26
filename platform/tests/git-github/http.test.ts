// HTTP behaviour of the GitHub adapter (design/ADR-M23 §2.1): retries of GETs, rate limits,
// conditional requests, links that leave the API host, options.
import net, { type AddressInfo } from 'node:net';

import { GitHubAdapter } from '@sdlc/adapter-git-github';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startHarness, type Harness } from './helpers';
import { FakeSecrets, pull, REPO } from './stub-github';

let h: Harness;
const PR = '/repos/acme/shop/pulls/7';

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await h.stub.stop();
});

describe('retries', () => {
  it('retries a GET after a 5xx answer with exponential backoff', async () => {
    let calls = 0;
    h.stub.on('GET', PR, () => {
      calls += 1;
      return calls < 3 ? { status: 503 } : { body: pull(7, '2026-09-26T07:00:00Z') };
    });
    await expect(h.adapter().getPullRequest(REPO, 7)).resolves.toMatchObject({ number: 7 });
    expect(calls).toBe(3);
    expect(h.sleeps).toEqual([500, 1000]);
    expect(h.logs.filter((l) => l.event === 'git_host.request_retry').map((l) => l.fields)).toEqual(
      [
        { code: 'server_error', attempt: 1, status: 503 },
        { code: 'server_error', attempt: 2, status: 503 },
      ],
    );
  });

  it('gives up after maxRetries', async () => {
    h.stub.on('GET', PR, { status: 500 });
    await expect(h.adapter({ maxRetries: 1 }).getPullRequest(REPO, 7)).rejects.toMatchObject({
      code: 'server_error',
      params: { status: 500 },
    });
    expect(h.stub.requestsTo('GET', PR)).toHaveLength(2);
  });

  it('reports a network error when GitHub cannot be reached', async () => {
    // A port that was free a moment ago: nothing listens there.
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const a = h.adapter({ apiUrl: `http://127.0.0.1:${port}`, maxRetries: 1 });
    await expect(
      a.issueShortLivedToken(REPO, { permissions: { contents: 'read' } }),
    ).rejects.toMatchObject({
      code: 'network_error',
    });
    expect(h.sleeps).toEqual([500]);
  });
});

describe('rate limits', () => {
  it.each([
    [
      403,
      { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1790409600' },
      '2026-09-26T08:00:00.000Z',
    ],
    [429, { 'retry-after': '30' }, '2026-09-26T08:00:30.000Z'],
    [403, { 'retry-after': '60' }, '2026-09-26T08:01:00.000Z'],
  ])('a %i with %o is rate_limited, retry at %s, no sleep', async (status, headers, retryAt) => {
    h.stub.on('GET', PR, { status, headers, body: { message: 'API rate limit exceeded' } });
    await expect(h.adapter().getPullRequest(REPO, 7)).rejects.toMatchObject({
      code: 'rate_limited',
      params: { retry_at: retryAt },
    });
    expect(h.sleeps).toEqual([]);
    expect(h.stub.requestsTo('GET', PR)).toHaveLength(1);
  });

  it('a 403 without rate-limit headers is forbidden', async () => {
    h.stub.on('GET', PR, {
      status: 403,
      body: { message: 'Resource not accessible by integration' },
    });
    await expect(h.adapter().getPullRequest(REPO, 7)).rejects.toMatchObject({
      code: 'forbidden',
      params: { status: 403 },
    });
  });

  it('warns when the remaining quota is low', async () => {
    h.stub.on('GET', PR, {
      body: pull(7, '2026-09-26T07:00:00Z'),
      headers: { 'x-ratelimit-remaining': '42' },
    });
    await h.adapter().getPullRequest(REPO, 7);
    expect(h.logs.find((l) => l.event === 'git_host.rate_limit_low')?.fields).toEqual({
      remaining: 42,
    });
  });
});

describe('links and hosts', () => {
  it('never follows a pagination link to another host (the token would leak)', async () => {
    h.stub.on('GET', '/repos/acme/shop/pulls/7/reviews', {
      body: [],
      headers: { link: '<https://evil.example.com/steal?page=2>; rel="next"' },
    });
    await expect(h.adapter().getApprovals(REPO, 7)).rejects.toMatchObject({
      code: 'invalid_response',
      params: { field: 'link' },
    });
    expect(h.stub.requests.every((r) => r.path.startsWith('/'))).toBe(true);
  });

  it.each([
    ['http without allowPlaintext', { apiUrl: 'http://api.github.com' }],
    ['credentials in the URL', { apiUrl: 'https://user:pw@api.github.com' }],
    ['a query', { apiUrl: 'https://api.github.com/?x=1' }],
    ['not a URL', { apiUrl: 'nope' }],
    ['a bad number', { maxRetries: 99 }],
  ])('refuses options with %s', (_case, extra) => {
    expect(() => new GitHubAdapter({ secrets: new FakeSecrets(), ...extra })).toThrow(
      expect.objectContaining({ code: 'invalid_input' }),
    );
  });
});

describe('conditional requests', () => {
  it('sends If-None-Match on list calls and reuses the cached body on 304', async () => {
    let calls = 0;
    h.stub.on('GET', '/repos/acme/shop/pulls/7/reviews', (req) => {
      calls += 1;
      if (req.headers['if-none-match'] === '"v1"')
        return { status: 304, headers: { etag: '"v1"' } };
      return { body: [], headers: { etag: '"v1"' } };
    });
    const a = h.adapter();
    await a.getApprovals(REPO, 7);
    await a.getApprovals(REPO, 7);
    expect(calls).toBe(2);
    expect(
      h.stub.requestsTo('GET', '/repos/acme/shop/pulls/7/reviews')[1]?.headers['if-none-match'],
    ).toBe('"v1"');
  });
});
