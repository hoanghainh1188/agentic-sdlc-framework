// QUESTIONS #20: with TLS on, the client verifies the OpenBao server certificate against the
// company internal CA (SDLC_OPENBAO_CA_CERT_FILE). No option turns verification off. The real CA
// and the TLS listener come in A10; here THROW-AWAY CAs are made in a temp folder with openssl.
import fs from 'node:fs';

import { OpenBaoClient, SecretsError } from '@sdlc/secrets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { credentialFiles, StubOpenBao } from './stub-openbao';
import { DAY_MS, ThrowawayCa, type ServerCert } from './throwaway-ca';

const now = Date.now();
let internalCa: ThrowawayCa;
let otherCa: ThrowawayCa;
let valid: ServerCert;
let expired: ServerCert;
let wrongHost: ServerCert;
const files = credentialFiles();
const stubs: StubOpenBao[] = [];

async function serve(cert: ServerCert): Promise<StubOpenBao> {
  const stub = await StubOpenBao.start(cert);
  stubs.push(stub);
  return stub;
}

async function statusWith(stub: StubOpenBao, caCertFile?: string): Promise<unknown> {
  const client = new OpenBaoClient({
    address: stub.address,
    roleIdFile: files.roleIdFile,
    secretIdFile: files.secretIdFile,
    ...(caCertFile ? { caCertFile } : {}),
  });
  try {
    return await client.sealStatus();
  } catch (error) {
    return error;
  } finally {
    await client.close();
  }
}

function tlsError(result: unknown): SecretsError {
  expect(result).toBeInstanceOf(SecretsError);
  expect((result as SecretsError).key).toBe('secrets.openbao.tls_failed');
  return result as SecretsError;
}

beforeAll(() => {
  internalCa = ThrowawayCa.create('internal');
  otherCa = ThrowawayCa.create('other');
  valid = internalCa.issue(
    ['localhost', '127.0.0.1'],
    new Date(now - DAY_MS),
    new Date(now + DAY_MS),
  );
  expired = internalCa.issue(['127.0.0.1'], new Date(now - 3 * DAY_MS), new Date(now - 2 * DAY_MS));
  wrongHost = internalCa.issue(['openbao.example'], new Date(now - DAY_MS), new Date(now + DAY_MS));
});

afterAll(async () => {
  await Promise.all(stubs.map((s) => s.stop()));
  internalCa.remove();
  otherCa.remove();
  fs.rmSync(files.dir, { recursive: true, force: true });
});

describe('TLS verification against the internal CA', () => {
  it('a certificate from the configured CA is accepted', async () => {
    const stub = await serve(valid);
    expect(await statusWith(stub, internalCa.certFile)).toEqual({
      initialized: true,
      sealed: false,
    });
  });

  it('without the CA file (public roots only) the internal certificate is refused', async () => {
    const error = tlsError(await statusWith(await serve(valid)));
    expect(error.message).toMatch(/could not be verified .*SDLC_OPENBAO_CA_CERT_FILE/);
  });

  it('a certificate from another CA is refused', async () => {
    tlsError(await statusWith(await serve(valid), otherCa.certFile));
  });

  it('an expired certificate is refused', async () => {
    const error = tlsError(await statusWith(await serve(expired), internalCa.certFile));
    expect(error.params['reason']).toBe('CERT_HAS_EXPIRED');
  });

  it('a certificate for another host name is refused', async () => {
    const error = tlsError(await statusWith(await serve(wrongHost), internalCa.certFile));
    expect(error.params['reason']).toBe('ERR_TLS_CERT_ALTNAME_INVALID');
  });

  it('NODE_TLS_REJECT_UNAUTHORIZED=0 does not turn verification off', async () => {
    const stub = await serve(valid);
    const before = process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
    try {
      tlsError(await statusWith(stub, otherCa.certFile));
    } finally {
      if (before === undefined) delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
      else process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = before;
    }
  });
});
