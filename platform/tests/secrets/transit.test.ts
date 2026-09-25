// D-08 A04 AC1: Transit sign and verify with Ed25519, key version handling (D-03 §8, D-05
// `run_contracts.key_version`). Unit level against the stub; the live test signs with the real
// `run-contract` key.
import crypto from 'node:crypto';
import fs from 'node:fs';

import { OpenBaoClient, parseSignature, SecretsError, verifyEd25519 } from '@sdlc/secrets';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { credentialFiles, StubOpenBao } from './stub-openbao';

let stub: StubOpenBao;
let files: ReturnType<typeof credentialFiles>;
let client: OpenBaoClient;
const payload = new TextEncoder().encode('{"run_id":"RUN-1","tenant_id":"t-1"}');

beforeEach(async () => {
  stub = await StubOpenBao.start();
  files = credentialFiles();
  client = new OpenBaoClient({
    address: stub.address,
    allowPlaintext: true,
    roleIdFile: files.roleIdFile,
    secretIdFile: files.secretIdFile,
  });
});

afterEach(async () => {
  await client.close();
  await stub.stop();
  fs.rmSync(files.dir, { recursive: true, force: true });
});

describe('Transit sign and verify (Ed25519)', () => {
  it('signs with the latest key version and verifies through OpenBao and locally', async () => {
    const key = client.transit();
    const { signature, keyVersion } = await key.sign(payload);
    expect(keyVersion).toBe(1);
    expect(signature).toMatch(/^vault:v1:/);
    expect(await key.verify(payload, signature)).toBe(true);
    expect(await key.verifyLocally(payload, signature)).toBe(true);
  });

  it('a changed payload does not verify, through OpenBao or locally', async () => {
    const key = client.transit();
    const { signature } = await key.sign(payload);
    const changed = new TextEncoder().encode('{"run_id":"RUN-2","tenant_id":"t-1"}');
    expect(await key.verify(changed, signature)).toBe(false);
    expect(await key.verifyLocally(changed, signature)).toBe(false);
  });

  it('a malformed signature is false, without a request', async () => {
    const key = client.transit();
    for (const bad of [
      '',
      'vault:v0:AAAA',
      'vault:1:AAAA',
      'vault:v1:not base64!',
      'vault:v1:AAAA',
    ]) {
      expect(await key.verify(payload, bad)).toBe(false);
      expect(await key.verifyLocally(payload, bad)).toBe(false);
    }
    expect(stub.requests.filter((r) => r.includes('transit'))).toEqual([]);
  });

  it('handles several key versions: sign with an older one; each verifies with its own public key', async () => {
    stub.keys.push(stub.keys[0]!); // placeholder, replaced below
    const second = crypto.generateKeyPairSync('ed25519');
    const der = second.publicKey.export({ format: 'der', type: 'spki' });
    stub.keys[1] = { privateKey: second.privateKey, publicRaw: der.subarray(der.length - 32) };
    const key = client.transit();
    const v2 = await key.sign(payload);
    const v1 = await key.sign(payload, { keyVersion: 1 });
    expect([v1.keyVersion, v2.keyVersion]).toEqual([1, 2]);
    expect(await key.verifyLocally(payload, v1.signature)).toBe(true);
    expect(await key.verifyLocally(payload, v2.signature)).toBe(true);
    const v1Key = await key.publicKey(1);
    expect(verifyEd25519(v1Key, payload, v2.signature)).toBe(false);
    expect(stub.count('GET /v1/transit/keys/run-contract')).toBe(1); // cached
  });

  it('an unknown key version is a clear error', async () => {
    const key = client.transit();
    const error = await key.sign(payload, { keyVersion: 7 }).catch((e: unknown) => e);
    expect((error as SecretsError).key).toBe('secrets.transit.rejected');
    const missing = await key.publicKey(7).catch((e: unknown) => e);
    expect((missing as SecretsError).key).toBe('secrets.transit.unknown_key_version');
    expect((missing as SecretsError).params).toEqual({ key: 'run-contract', version: '7' });
  });

  it('refuses a key that is not Ed25519', async () => {
    stub.override = (req) =>
      req.url?.includes('/transit/keys/')
        ? { status: 200, body: { data: { type: 'rsa-2048', keys: {} } } }
        : undefined;
    const error = await client
      .transit()
      .publicKey(1)
      .catch((e: unknown) => e);
    expect((error as SecretsError).key).toBe('secrets.transit.not_ed25519');
  });

  it('refuses an invalid key name before any request', () => {
    expect(() => client.transit('../sys')).toThrow(SecretsError);
  });
});

describe('parseSignature and verifyEd25519', () => {
  it('parses prefix, version and 64 signature bytes', () => {
    const sig = `vault:v12:${Buffer.alloc(64, 1).toString('base64')}`;
    expect(parseSignature(sig)).toMatchObject({ prefix: 'vault', keyVersion: 12 });
    expect(parseSignature(sig)?.bytes).toHaveLength(64);
    expect(parseSignature(`vault:v1:${Buffer.alloc(63).toString('base64')}`)).toBeUndefined();
  });

  it('verifies a signature made by Node with the raw public key', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const der = publicKey.export({ format: 'der', type: 'spki' });
    const sig = `vault:v1:${crypto.sign(null, payload, privateKey).toString('base64')}`;
    expect(verifyEd25519(der.subarray(der.length - 32), payload, sig)).toBe(true);
    expect(verifyEd25519(new Uint8Array(31), payload, sig)).toBe(false);
  });
});
