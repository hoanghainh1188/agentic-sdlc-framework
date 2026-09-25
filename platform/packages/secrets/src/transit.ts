// Transit sign and verify with an Ed25519 key (Run Contracts, D-03 §8, ADR-M05). The private key
// never leaves OpenBao. Key versions: `sign` uses the latest version unless one is given; the
// version is part of every signature (`vault:v<N>:…`) and is stored with the contract (D-05).
import type { RunContractSigner, RunContractVerifier, SignatureResult } from '@sdlc/contracts';

import type { Caller } from './client.js';
import { ED25519_PUBLIC_KEY_BYTES, parseSignature, verifyEd25519 } from './ed25519.js';
import { SecretsError } from './errors.js';

const KEY_NAME = /^[A-Za-z0-9_-]+$/;

export class TransitKey implements RunContractSigner, RunContractVerifier {
  readonly #mount: string;
  readonly #publicKeys = new Map<number, Uint8Array>();

  constructor(
    mount: string,
    readonly key: string,
    private readonly call: Caller,
  ) {
    if (!KEY_NAME.test(key)) throw new SecretsError('secrets.transit.invalid_key_name', { key });
    this.#mount = mount;
  }

  async sign(payload: Uint8Array, options: { keyVersion?: number } = {}): Promise<SignatureResult> {
    const { keyVersion } = options;
    if (keyVersion !== undefined && (!Number.isInteger(keyVersion) || keyVersion < 1)) {
      throw new SecretsError('secrets.transit.unknown_key_version', {
        key: this.key,
        version: String(keyVersion),
      });
    }
    const res = await this.call({
      operation: 'sign',
      method: 'POST',
      path: this.#endpoint('sign'),
      body: { input: base64(payload), ...(keyVersion ? { key_version: keyVersion } : {}) },
      accept: [400],
    });
    if (res.status === 400) {
      throw new SecretsError('secrets.transit.rejected', { operation: 'sign', key: this.key });
    }
    const data = (res.body as { data?: { signature?: unknown; key_version?: unknown } })?.data;
    const signature = data?.signature;
    const parsed = typeof signature === 'string' ? parseSignature(signature) : undefined;
    if (!parsed || parsed.keyVersion !== data?.key_version) {
      throw new SecretsError('secrets.openbao.invalid_response', { operation: 'sign' });
    }
    return { signature: signature as string, keyVersion: parsed.keyVersion };
  }

  /** Verifies through OpenBao. A malformed or rejected signature is `false`, never an error. */
  async verify(payload: Uint8Array, signature: string): Promise<boolean> {
    if (!parseSignature(signature)) return false;
    const res = await this.call({
      operation: 'verify',
      method: 'POST',
      path: this.#endpoint('verify'),
      body: { input: base64(payload), signature },
      accept: [400],
    });
    if (res.status === 400) return false;
    return (res.body as { data?: { valid?: unknown } })?.data?.valid === true;
  }

  /** Verifies locally with the public key of the signature's key version. */
  async verifyLocally(payload: Uint8Array, signature: string): Promise<boolean> {
    const parsed = parseSignature(signature);
    if (!parsed) return false;
    return verifyEd25519(await this.publicKey(parsed.keyVersion), payload, signature);
  }

  /** Raw Ed25519 public key (32 bytes) of a key version. Cached: a version's key never changes. */
  async publicKey(keyVersion: number): Promise<Uint8Array> {
    const cached = this.#publicKeys.get(keyVersion);
    if (cached) return cached;
    const res = await this.call({ operation: 'read', method: 'GET', path: this.#endpoint('keys') });
    const data = (res.body as { data?: { type?: unknown; keys?: unknown } })?.data;
    if (data?.type !== 'ed25519' || !data.keys || typeof data.keys !== 'object') {
      throw new SecretsError('secrets.transit.not_ed25519', { key: this.key });
    }
    for (const [version, entry] of Object.entries(data.keys as Record<string, unknown>)) {
      const encoded = (entry as { public_key?: unknown })?.public_key;
      const bytes = typeof encoded === 'string' ? Buffer.from(encoded, 'base64') : Buffer.alloc(0);
      if (bytes.length !== ED25519_PUBLIC_KEY_BYTES) {
        throw new SecretsError('secrets.openbao.invalid_response', {
          operation: 'read public key',
        });
      }
      this.#publicKeys.set(Number(version), new Uint8Array(bytes));
    }
    const key = this.#publicKeys.get(keyVersion);
    if (!key) {
      throw new SecretsError('secrets.transit.unknown_key_version', {
        key: this.key,
        version: String(keyVersion),
      });
    }
    return key;
  }

  #endpoint(action: 'sign' | 'verify' | 'keys'): string {
    return `${this.#mount}/${action}/${this.key}`;
  }
}

function base64(payload: Uint8Array): string {
  return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString('base64');
}
