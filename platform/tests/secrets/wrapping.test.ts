// Response wrapping (ADR-M25 §2.11, QUESTIONS #44): the worker wraps the run's GitHub token, the
// runner unwraps it once. A used, expired or foreign wrapping token is refused; no value leaks.
import fs from 'node:fs';

import { OpenBaoClient, Redacted, SecretsError } from '@sdlc/secrets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { credentialFiles, MARKER, StubOpenBao } from './stub-openbao';

const TOKEN = `ghs_${MARKER}_installation`;

describe('response wrapping', () => {
  let stub: StubOpenBao;
  let files: ReturnType<typeof credentialFiles>;
  let worker: OpenBaoClient;
  let runner: OpenBaoClient;

  beforeAll(async () => {
    stub = await StubOpenBao.start();
    files = credentialFiles();
    const options = {
      address: stub.address,
      allowPlaintext: true,
      roleIdFile: files.roleIdFile,
      secretIdFile: files.secretIdFile,
    };
    worker = new OpenBaoClient(options);
    runner = new OpenBaoClient(options);
  });

  afterAll(async () => {
    await worker.close();
    await runner.close();
    await stub.stop();
    fs.rmSync(files.dir, { recursive: true, force: true });
  });

  const wrapToken = () =>
    worker.wrapping().wrap({ token: new Redacted(TOKEN) }, { ttlSeconds: 900 });

  it('wraps with the requested TTL and unwraps once, without logging in', async () => {
    const wrapped = await wrapToken();
    expect(JSON.stringify({ wrapped })).toBe('{"wrapped":"[redacted]"}');
    expect(stub.wrapTtls.at(-1)).toBe('900s');
    const logins = stub.count('POST /v1/auth/approle/login');
    const fields = await runner.wrapping().unwrap(wrapped);
    expect(fields.token?.reveal()).toBe(TOKEN);
    expect(JSON.stringify(fields)).not.toContain(MARKER);
    // unwrap is authenticated by the wrapping token itself.
    expect(stub.count('POST /v1/auth/approle/login')).toBe(logins);
  });

  it('refuses a second unwrap: someone used the token first', async () => {
    const wrapped = await wrapToken();
    await runner.wrapping().unwrap(wrapped);
    const error = await runner
      .wrapping()
      .unwrap(wrapped)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SecretsError);
    expect((error as SecretsError).key).toBe('secrets.wrapping.invalid_token');
    expect(String(error)).not.toContain(MARKER);
  });

  it('refuses an unknown or expired token', async () => {
    await expect(runner.wrapping().unwrap(new Redacted('wrap-unknown'))).rejects.toMatchObject({
      key: 'secrets.wrapping.invalid_token',
    });
    const wrapped = await wrapToken();
    for (const entry of stub.wrapped.values()) entry.expiresAt = Date.now() - 1;
    await expect(runner.wrapping().unwrap(wrapped)).rejects.toMatchObject({
      key: 'secrets.wrapping.invalid_token',
    });
  });

  it('refuses a wrapping token made by another endpoint (for example a wrapped secret ID)', async () => {
    stub.wrapped.clear();
    const wrapped = await wrapToken();
    for (const entry of stub.wrapped.values()) entry.path = 'auth/approle/role/runner/secret-id';
    await expect(runner.wrapping().unwrap(wrapped)).rejects.toMatchObject({
      key: 'secrets.wrapping.wrong_origin',
    });
    // The lookup did not use the token up.
    expect([...stub.wrapped.values()]).toHaveLength(1);
    stub.wrapped.clear();
  });

  it.each([
    [{}, 900],
    [{ Token: new Redacted('x') }, 900],
    [{ token: new Redacted('x') }, 0],
    [{ token: new Redacted('x') }, 3601],
  ])('refuses bad input to wrap', async (fields, ttlSeconds) => {
    await expect(worker.wrapping().wrap(fields, { ttlSeconds })).rejects.toMatchObject({
      key: 'secrets.wrapping.invalid_input',
    });
  });

  it('reports a policy refusal on wrap as such', async () => {
    stub.denied.add('sys/wrapping/wrap');
    await expect(wrapToken()).rejects.toMatchObject({ key: 'secrets.permission_denied' });
    stub.denied.delete('sys/wrapping/wrap');
  });
});
