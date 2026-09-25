// Transit signature format and local Ed25519 verification (D-03 §8: the runner verifies with the
// public key obtained from OpenBao).
import crypto from 'node:crypto';

export interface ParsedSignature {
  /** `vault` for OpenBao 2.x. */
  readonly prefix: string;
  readonly keyVersion: number;
  readonly bytes: Buffer;
}

const SIGNATURE = /^([a-z]+):v([1-9][0-9]{0,8}):([A-Za-z0-9+/]+={0,2})$/;
// DER header of an Ed25519 SubjectPublicKeyInfo (RFC 8410); the 32 key bytes follow.
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
export const ED25519_PUBLIC_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;

/** Parses `<prefix>:v<version>:<base64>`; undefined when the format is wrong. */
export function parseSignature(signature: string): ParsedSignature | undefined {
  const match = SIGNATURE.exec(signature);
  if (!match) return undefined;
  const bytes = Buffer.from(match[3]!, 'base64');
  if (bytes.length !== ED25519_SIGNATURE_BYTES) return undefined;
  return { prefix: match[1]!, keyVersion: Number(match[2]), bytes };
}

/** Verifies an Ed25519 signature (raw 32-byte public key) without calling OpenBao. */
export function verifyEd25519(
  publicKey: Uint8Array,
  payload: Uint8Array,
  signature: string,
): boolean {
  const parsed = parseSignature(signature);
  if (!parsed || publicKey.length !== ED25519_PUBLIC_KEY_BYTES) return false;
  const key = crypto.createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, publicKey]),
    format: 'der',
    type: 'spki',
  });
  return crypto.verify(null, payload, key, parsed.bytes);
}
