// A software passkey for tests (task U06): a P-256 key made at run time, which answers WebAuthn
// registration and authentication requests like a platform authenticator (attestation `none`,
// user present and verified). Never used outside tests; no key is ever written to a file.
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');
const sha256 = (bytes: Uint8Array | string): Buffer => createHash('sha256').update(bytes).digest();

// --- A minimal CBOR encoder (RFC 8949): what attestation objects and COSE keys need. ---
type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>;

function head(major: number, value: number): Buffer {
  if (value < 24) return Buffer.from([(major << 5) | value]);
  if (value < 256) return Buffer.from([(major << 5) | 24, value]);
  if (value < 65_536) {
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(value, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(value, 1);
  return b;
}

export function cbor(value: Cbor): Buffer {
  if (typeof value === 'number') {
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  }
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), value]);
  const parts = [head(5, value.size)];
  for (const [k, v] of value) parts.push(cbor(k), cbor(v));
  return Buffer.concat(parts);
}

export interface SoftAuthenticatorOptions {
  /** The origin the browser would report, for example `http://localhost:8090`. */
  readonly origin: string;
  /** False: the authenticator reports no user verification (a step-up must refuse it). */
  readonly userVerified?: boolean;
  /** The counter to report next; `null`: always 0 (like a synced passkey). */
  readonly counter?: number | null;
}

export class SoftAuthenticator {
  readonly credentialId = randomBytes(32);
  readonly #privateKey: KeyObject;
  readonly #cosePublicKey: Buffer;
  #counter: number | null;
  origin: string;
  userVerified: boolean;

  constructor(options: SoftAuthenticatorOptions) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.#privateKey = privateKey;
    const jwk = publicKey.export({ format: 'jwk' });
    this.#cosePublicKey = cbor(
      new Map<Cbor, Cbor>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, Buffer.from(jwk.x!, 'base64url')],
        [-3, Buffer.from(jwk.y!, 'base64url')],
      ]),
    );
    this.origin = options.origin;
    this.userVerified = options.userVerified ?? true;
    this.#counter = options.counter === undefined ? 1 : options.counter;
  }

  get id(): string {
    return b64url(this.credentialId);
  }

  /** Sets the counter the next answer reports (a counter going back: a cloned authenticator). */
  setCounter(value: number | null): void {
    this.#counter = value;
  }

  #flags(attested: boolean): number {
    return 0x01 | (this.userVerified ? 0x04 : 0) | (attested ? 0x40 : 0);
  }

  #count(): Buffer {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(this.#counter ?? 0, 0);
    if (this.#counter !== null) this.#counter += 1;
    return b;
  }

  #clientData(type: string, challenge: string): Buffer {
    return Buffer.from(
      JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false }),
      'utf8',
    );
  }

  /** The browser's `toJSON()` of `navigator.credentials.create(options)`. */
  register(options: { challenge: string; rp: { id?: string } }): Record<string, unknown> {
    const rpId = options.rp.id ?? new URL(this.origin).hostname;
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.credentialId.length, 0);
    const authData = Buffer.concat([
      sha256(rpId),
      Buffer.from([this.#flags(true)]),
      this.#count(),
      Buffer.alloc(16), // AAGUID: none
      idLength,
      this.credentialId,
      this.#cosePublicKey,
    ]);
    const attestationObject = cbor(
      new Map<Cbor, Cbor>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64url(this.#clientData('webauthn.create', options.challenge)),
        attestationObject: b64url(attestationObject),
        transports: ['internal'],
      },
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
    };
  }

  /** The browser's `toJSON()` of `navigator.credentials.get(options)`. */
  authenticate(options: { challenge: string; rpId?: string }): Record<string, unknown> {
    const rpId = options.rpId ?? new URL(this.origin).hostname;
    const authData = Buffer.concat([
      sha256(rpId),
      Buffer.from([this.#flags(false)]),
      this.#count(),
    ]);
    const clientData = this.#clientData('webauthn.get', options.challenge);
    const signature = sign(
      'sha256',
      Buffer.concat([authData, sha256(clientData)]),
      this.#privateKey,
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64url(clientData),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
      },
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
    };
  }
}
