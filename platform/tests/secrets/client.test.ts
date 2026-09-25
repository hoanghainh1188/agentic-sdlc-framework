// D-08 A04 AC1 (unit level, against an in-process stub): AppRole login, token renewal and new
// login, KV v2 read, Transit sign and verify; QUESTIONS #2 (clear error when OpenBao is sealed or
// not initialised). The live test against OpenBao in Compose is
// platform/tests/integration/openbao/secrets-client.test.ts (AC2).
import fs from 'node:fs';

import {
  OpenBaoClient,
  SecretsError,
  type OpenBaoClientOptions,
  type SecretsLogEvent,
  type SecretsLogger,
} from '@sdlc/secrets';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { credentialFiles, StubOpenBao } from './stub-openbao';

let stub: StubOpenBao;
let files: ReturnType<typeof credentialFiles>;
let events: { level: string; event: SecretsLogEvent; fields: Record<string, unknown> }[];
const clients: OpenBaoClient[] = [];

const logger: SecretsLogger = {
  log: (level, event, fields) => events.push({ level, event, fields: { ...fields } }),
};

function client(extra: Partial<OpenBaoClientOptions> = {}): OpenBaoClient {
  const c = new OpenBaoClient({
    address: extra.address ?? stub.address,
    allowPlaintext: true,
    roleIdFile: files.roleIdFile,
    secretIdFile: files.secretIdFile,
    logger,
    ...extra,
  });
  clients.push(c);
  return c;
}

async function rejection(promise: Promise<unknown>): Promise<SecretsError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(SecretsError);
  return error as SecretsError;
}

beforeEach(async () => {
  stub = await StubOpenBao.start();
  files = credentialFiles();
  events = [];
  stub.kv.set('worker/db', [{ password: 'old' }, { password: 'value-S3CR3T', port: 5432 }]);
});

afterEach(async () => {
  // Close first: close() clears the renewal timer, which is a fake timer in some tests.
  await Promise.all(clients.splice(0).map((c) => c.close()));
  vi.useRealTimers();
  await stub.stop();
  fs.rmSync(files.dir, { recursive: true, force: true });
});

describe('AppRole login and KV v2 read', () => {
  it('logs in on the first read and returns redacted values with the version', async () => {
    const entry = await client().kv().read('worker/db');
    expect(stub.count('POST /v1/auth/approle/login')).toBe(1);
    expect(entry.version).toBe(2);
    expect(entry.data['password']?.reveal()).toBe('value-S3CR3T');
    expect(entry.data['port']?.reveal()).toBe('5432');
    expect(JSON.stringify(entry.data)).toBe('{"password":"[redacted]","port":"[redacted]"}');
  });

  it('reads an older version on request', async () => {
    const entry = await client().kv().read('worker/db', { version: 1 });
    expect(entry.data['password']?.reveal()).toBe('old');
  });

  it('concurrent first calls share one login', async () => {
    const kv = client().kv();
    await Promise.all([kv.read('worker/db'), kv.read('worker/db'), kv.read('worker/db')]);
    expect(stub.count('POST /v1/auth/approle/login')).toBe(1);
  });

  it('a missing secret is not_found; bad paths and versions are refused before any request', async () => {
    const kv = client().kv();
    expect((await rejection(kv.read('worker/none'))).key).toBe('secrets.not_found');
    for (const bad of ['', '/worker', 'worker/', 'worker/../api', 'worker/./x', 'a b', 'x?y=1']) {
      expect((await rejection(kv.read(bad))).key).toBe('secrets.invalid_path');
    }
    expect((await rejection(kv.read('worker/db', { version: 0 }))).key).toBe(
      'secrets.invalid_version',
    );
    expect(stub.requests.filter((r) => r.includes('/kv/'))).toEqual([
      'GET /v1/kv/data/worker/none',
    ]);
  });

  it('a wrong secret ID fails with login_failed and the HTTP status', async () => {
    fs.writeFileSync(files.secretIdFile, 'wrong-S3CR3T\n');
    const error = await rejection(client().kv().read('worker/db'));
    expect(error.key).toBe('secrets.login_failed');
    expect(error.params).toMatchObject({ status: 400, file: files.secretIdFile });
  });

  it('reads the secret ID file again at every login (rotation without restart)', async () => {
    const c = client();
    await c.kv().read('worker/db');
    stub.secretId = 'rotated-S3CR3T';
    fs.writeFileSync(files.secretIdFile, 'rotated-S3CR3T\n');
    stub.revokeAll();
    await c.kv().read('worker/db');
    expect(stub.count('POST /v1/auth/approle/login')).toBe(2);
  });
});

describe('expired tokens and policy refusals (403)', () => {
  it('a revoked or expired token leads to one new login and one retry', async () => {
    const c = client();
    await c.kv().read('worker/db');
    stub.revokeAll();
    expect((await c.kv().read('worker/db')).version).toBe(2);
    expect(stub.count('POST /v1/auth/approle/login')).toBe(2);
    expect(stub.count('GET /v1/auth/token/lookup-self')).toBe(1);
    expect(events.map((e) => e.event)).toContain('openbao.token_expired');
  });

  it('a policy refusal is permission_denied, with no new login', async () => {
    stub.kv.set('api/x', [{ v: '1' }]);
    stub.denied.add('kv/data/api/x');
    const error = await rejection(client().kv().read('api/x'));
    expect(error.key).toBe('secrets.permission_denied');
    expect(error.params).toEqual({ operation: 'read', path: 'kv/data/api/x' });
    expect(stub.count('POST /v1/auth/approle/login')).toBe(1);
  });

  it('a token past its local expiry is not used: the client logs in first', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    stub.renewable = false;
    stub.ttl = 60;
    const c = client();
    await c.login();
    vi.setSystemTime(Date.now() + 58_000); // 2 s left: inside the safety margin, timer not run
    await c.kv().read('worker/db');
    expect(stub.count('POST /v1/auth/approle/login')).toBe(2);
    expect(stub.count('GET /v1/auth/token/lookup-self')).toBe(0);
  });
});

describe('token renewal', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  });

  it('renews at 2/3 of the TTL given by OpenBao', async () => {
    const c = client();
    await c.login();
    const before = c.tokenInfo()!.expiresAt;
    await vi.advanceTimersByTimeAsync(2_399_000);
    expect(stub.count('POST /v1/auth/token/renew-self')).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitUntil(() => stub.count('POST /v1/auth/token/renew-self') === 1);
    await vi.waitUntil(() => c.tokenInfo()!.expiresAt > before);
    expect(events.some((e) => e.event === 'openbao.token_renewed')).toBe(true);
  });

  it('when renewal gives less than asked (maximum TTL near), it logs in again and revokes the old token', async () => {
    const c = client();
    await c.login();
    stub.renewTtl = 600;
    await vi.advanceTimersByTimeAsync(2_400_000); // renew → 600 s left
    await vi.waitUntil(() => stub.count('POST /v1/auth/token/renew-self') === 1);
    await vi.advanceTimersByTimeAsync(400_000); // 2/3 of 600 s → new login
    await vi.waitUntil(() => stub.count('POST /v1/auth/token/revoke-self') === 1);
    expect(stub.count('POST /v1/auth/approle/login')).toBe(2);
    expect(stub.tokens.size).toBe(1);
    expect(stub.count('POST /v1/auth/token/renew-self')).toBe(1);
  });

  it('a token that is not renewable is replaced by a new login', async () => {
    stub.renewable = false;
    const c = client();
    await c.login();
    await vi.advanceTimersByTimeAsync(2_400_000);
    await vi.waitUntil(() => stub.count('POST /v1/auth/approle/login') === 2);
    expect(stub.count('POST /v1/auth/token/renew-self')).toBe(0);
  });

  it('a failed renewal is logged and retried while the token is valid; it never throws', async () => {
    const c = client();
    await c.login();
    stub.sealed = true;
    await vi.advanceTimersByTimeAsync(2_400_000);
    await vi.waitUntil(() => events.some((e) => e.event === 'openbao.renew_failed'));
    expect(events.find((e) => e.event === 'openbao.renew_failed')?.fields).toEqual({
      step: 'renew',
      error: 'secrets.openbao.sealed',
    });
    stub.sealed = false;
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitUntil(() => events.some((e) => e.event === 'openbao.token_renewed'));
  });
});

describe('sealed or not initialised OpenBao (QUESTIONS #2)', () => {
  it('not initialised: a clear error, not a bare 503', async () => {
    stub.initialized = false;
    const c = client();
    const error = await rejection(c.kv().read('worker/db'));
    expect(error.key).toBe('secrets.openbao.not_initialised');
    expect(error.message).toMatch(/is not initialised/);
    expect((await rejection(c.assertReady())).key).toBe('secrets.openbao.not_initialised');
  });

  it('sealed: a clear error at login and on requests with a token', async () => {
    const c = client();
    await c.login();
    stub.sealed = true;
    const error = await rejection(c.kv().read('worker/db'));
    expect(error.key).toBe('secrets.openbao.sealed');
    expect(error.message).toMatch(/is sealed\. Two key holders must unseal it/);
    expect((await rejection(client().login())).key).toBe('secrets.openbao.sealed');
    expect((await rejection(c.assertReady())).key).toBe('secrets.openbao.sealed');
  });

  it('an unsealed OpenBao passes assertReady', async () => {
    await expect(client().assertReady()).resolves.toBeUndefined();
  });

  it('a 503 while unsealed (for example a standby node) is an unexpected status', async () => {
    stub.override = (req) =>
      req.url?.includes('/kv/') ? { status: 503, body: { errors: ['standby'] } } : undefined;
    const error = await rejection(client().kv().read('worker/db'));
    expect(error.key).toBe('secrets.openbao.unexpected_status');
    expect(error.params['status']).toBe(503);
  });
});

describe('network failures', () => {
  it('unreachable: names the address and the Node error code', async () => {
    const address = stub.address;
    await stub.stop();
    const error = await rejection(client({ address }).kv().read('worker/db'));
    expect(error.key).toBe('secrets.openbao.unreachable');
    expect(error.params).toEqual({ address, reason: 'ECONNREFUSED' });
    stub = await StubOpenBao.start(); // for afterEach
  });

  it('no answer within the timeout', async () => {
    stub.override = () => ({ status: 0 });
    const error = await rejection(client({ timeoutMs: 200 }).sealStatus());
    expect(error.key).toBe('secrets.openbao.timeout');
    expect(error.params['seconds']).toBe(0.2);
  });

  it('a response that is not valid JSON of the expected shape is invalid_response', async () => {
    stub.override = (req) =>
      req.url?.endsWith('/login')
        ? { status: 200, body: { auth: { client_token: 1 } } }
        : undefined;
    expect((await rejection(client().login())).key).toBe('secrets.openbao.invalid_response');
  });
});

describe('close', () => {
  it('revokes the token and refuses later calls', async () => {
    const c = client();
    await c.login();
    await c.close();
    expect(stub.count('POST /v1/auth/token/revoke-self')).toBe(1);
    expect(stub.tokens.size).toBe(0);
    expect((await rejection(c.kv().read('worker/db'))).key).toBe('secrets.client_closed');
    await c.close(); // twice is fine
  });

  it('a login still in flight when close() runs is revoked, and no warning is logged', async () => {
    let release: () => void = () => undefined;
    stub.holdLogin = new Promise<void>((resolve) => (release = resolve));
    const c = client();
    const login = c.login();
    await vi.waitUntil(() => stub.count('POST /v1/auth/approle/login') === 1);
    const closing = c.close();
    release();
    expect((await rejection(login)).key).toBe('secrets.client_closed');
    await closing;
    await vi.waitUntil(() => stub.count('POST /v1/auth/token/revoke-self') === 1);
    expect(stub.tokens.size).toBe(0);
    expect(events.filter((e) => e.level !== 'info' && e.event !== 'openbao.plaintext')).toEqual([]);
  });
});

describe('plaintext http (allowed only with SDLC_OPENBAO_ALLOW_PLAINTEXT=1)', () => {
  it('logs a warning when the client is created and at every login', async () => {
    const c = client();
    await c.login();
    stub.revokeAll();
    await c.kv().read('worker/db');
    const warnings = events.filter((e) => e.event === 'openbao.plaintext');
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toMatchObject({ level: 'warn', fields: { address: stub.address } });
    expect(warnings[0]?.fields['message']).toMatch(/without TLS/);
  });
});
