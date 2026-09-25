// D-08 A04 AC3: never log secret values. Every credential, token and secret value served by the
// stub contains MARKER, and the stub's error texts echo the input. The client must never let
// MARKER reach an error message, stack trace, serialised error or log field.
import fs from 'node:fs';
import { inspect } from 'node:util';

import { OpenBaoClient, Redacted, REDACTED, type SecretsLogger } from '@sdlc/secrets';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { credentialFiles, MARKER, StubOpenBao } from './stub-openbao';

describe('Redacted', () => {
  const secret = new Redacted(`value-${MARKER}`);

  it('shows [redacted] in every string form', () => {
    expect(String(secret)).toBe(REDACTED);
    expect(secret.toString()).toBe(REDACTED);
    expect(`x${secret as unknown as string}`).toBe(`x${REDACTED}`);
    expect(JSON.stringify({ secret })).toBe(`{"secret":"${REDACTED}"}`);
    expect(inspect(secret)).toBe(REDACTED);
    expect(inspect({ nested: { secret } }, { depth: 5 })).not.toContain(MARKER);
    expect(Object.keys(secret)).toEqual([]);
    expect(JSON.stringify({ ...secret })).toBe('{}');
  });

  it('reveal() is the only way to the value', () => {
    expect(secret.reveal()).toBe(`value-${MARKER}`);
  });
});

describe('no secret in errors, stack traces or logs', () => {
  let stub: StubOpenBao;
  let files: ReturnType<typeof credentialFiles>;
  const logged: string[] = [];
  const logger: SecretsLogger = { log: (...args) => logged.push(JSON.stringify(args)) };
  const clients: OpenBaoClient[] = [];

  const client = (): OpenBaoClient => {
    const c = new OpenBaoClient({
      address: stub.address,
      allowPlaintext: true,
      roleIdFile: files.roleIdFile,
      secretIdFile: files.secretIdFile,
      logger,
      timeoutMs: 300,
    });
    clients.push(c);
    return c;
  };

  const everyForm = (error: unknown): string =>
    [
      String(error),
      (error as Error).stack ?? '',
      JSON.stringify(error),
      inspect(error, { depth: 10, showHidden: true }),
      JSON.stringify((error as { params?: unknown }).params ?? {}),
    ].join('\n');

  beforeEach(async () => {
    stub = await StubOpenBao.start();
    files = credentialFiles();
    stub.kv.set('worker/db', [{ password: `value-${MARKER}` }]);
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()));
    await stub.stop();
    fs.rmSync(files.dir, { recursive: true, force: true });
  });

  const failures: [string, (s: StubOpenBao) => void, (c: OpenBaoClient) => Promise<unknown>][] = [
    ['wrong secret ID (OpenBao echoes it)', (s) => (s.secretId = 'other'), (c) => c.login()],
    [
      'policy refusal (OpenBao echoes the token)',
      (s) => s.denied.add('kv/data/worker/db'),
      (c) => c.kv().read('worker/db'),
    ],
    ['sealed', (s) => (s.sealed = true), (c) => c.kv().read('worker/db')],
    ['not initialised', (s) => (s.initialized = false), (c) => c.kv().read('worker/db')],
    [
      'timeout',
      (s) => (s.override = (req) => (req.url?.includes('/kv/') ? { status: 0 } : undefined)),
      (c) => c.kv().read('worker/db'),
    ],
    [
      'invalid response',
      (s) =>
        (s.override = (req) =>
          req.url?.includes('/kv/') ? { status: 200, body: { data: `x-${MARKER}` } } : undefined),
      (c) => c.kv().read('worker/db'),
    ],
    [
      'unexpected status',
      (s) =>
        (s.override = (req) =>
          req.url?.includes('/kv/') ? { status: 500, body: { errors: [MARKER] } } : undefined),
      (c) => c.kv().read('worker/db'),
    ],
    [
      'transit refusal',
      (s) =>
        (s.override = (req) =>
          req.url?.includes('/sign/') ? { status: 400, body: { errors: [MARKER] } } : undefined),
      (c) => c.transit().sign(new Uint8Array([1])),
    ],
  ];

  it.each(failures)('%s', async (_name, arrange, act) => {
    const c = client();
    await c.login().catch(() => undefined);
    arrange(stub);
    const error = await act(c).then(
      () => new Error('expected a failure'),
      (e: unknown) => e,
    );
    expect(error).toHaveProperty('key');
    expect(everyForm(error)).not.toContain(MARKER);
    expect((error as Error).cause).toBeUndefined();
  });

  it('the client object itself shows no token or credential', async () => {
    const c = client();
    await c.kv().read('worker/db');
    expect(inspect(c, { depth: 10, showHidden: true })).not.toContain(MARKER);
    expect(JSON.stringify(c)).not.toContain(MARKER);
    expect(JSON.stringify(c.tokenInfo())).not.toContain(MARKER);
  });

  it('log fields never hold a secret, across login, renewal, expiry and close', async () => {
    const c = client();
    const entry = await c.kv().read('worker/db');
    await c.renewNow();
    stub.revokeAll();
    await c.kv().read('worker/db');
    await c.close();
    expect(logged.length).toBeGreaterThan(3);
    expect(logged.join('\n')).not.toContain(MARKER);
    expect(JSON.stringify(entry)).not.toContain(MARKER);
  });
});
