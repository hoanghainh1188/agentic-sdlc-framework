// The trial stack's key file (D-08 V08, QUESTIONS #356, #415, #418, design/ADR-M76): the OpenBao
// key shares needed to unseal it (the threshold, 2), encrypted with the person's passphrase
// (age, scrypt) by the library `age-encryption`, so the stack survives a reboot or
// `pnpm trial:down`. Never the root token (it stays revoked). Only `pnpm trial:start` reads it,
// and only for its own Compose project. Plaintext never touches the disk: the record is encrypted
// in memory and only the ciphertext is written.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { Decrypter, Encrypter } from 'age-encryption';

/** Next to the trial's env file; Git-ignored (`.gitignore`, static test). */
export const KEY_FILE_NAME = 'trial-openbao-keys.age';
/** The shares needed to unseal (bootstrap.conf `BAO_KEY_THRESHOLD`; `trial:up` unseals with 2). */
export const KEY_THRESHOLD = 2;
/** The library's default scrypt work factor (2^18: about 1 second, 256 MiB). */
export const SCRYPT_LOG_N = 18;
/** The AppRole secret IDs live 90 days and a trial stack cannot renew them (QUESTIONS #417). */
export const TRIAL_MAX_DAYS = 90;
export const TRIAL_WARNING_DAYS = 80;

const RECORD_VERSION = 1;
const AGE_HEADER = 'age-encryption.org/v1\n';
/** A record is a few hundred bytes; anything much larger is not a key file. */
const MAX_FILE_BYTES = 64 * 1024;

export interface KeyRecord {
  readonly project: string;
  readonly createdAt: string;
  readonly shares: readonly string[];
}

export type KeyFileErrorCode =
  'missing' | 'mode' | 'exists' | 'invalid' | 'wrong_passphrase' | 'project_mismatch';

/** A refusal about the key file; never carries a share or the passphrase. */
export class KeyFileError extends Error {
  constructor(readonly code: KeyFileErrorCode) {
    super(`key file: ${code}`);
  }
}

/** The key file of a trial env file: in the same folder. Pure. */
export function keyFileFor(envFile: string): string {
  return path.join(path.dirname(path.resolve(envFile)), KEY_FILE_NAME);
}

/** Encrypts a record with the passphrase, in memory. */
export async function encryptKeys(
  record: KeyRecord,
  passphrase: string,
  logN = SCRYPT_LOG_N,
): Promise<Uint8Array> {
  if (record.shares.length !== KEY_THRESHOLD || record.shares.some((s) => s === '')) {
    throw new KeyFileError('invalid');
  }
  const e = new Encrypter();
  e.setPassphrase(passphrase);
  e.setScryptWorkFactor(logN);
  const body = JSON.stringify({
    v: RECORD_VERSION,
    project: record.project,
    created_at: record.createdAt,
    threshold: KEY_THRESHOLD,
    shares: record.shares,
  });
  return e.encrypt(body);
}

function parseRecord(text: string): KeyRecord {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new KeyFileError('invalid');
  }
  const b = body as Record<string, unknown>;
  const shares = b.shares;
  if (
    b.v !== RECORD_VERSION ||
    typeof b.project !== 'string' ||
    typeof b.created_at !== 'string' ||
    b.threshold !== KEY_THRESHOLD ||
    !Array.isArray(shares) ||
    shares.length !== KEY_THRESHOLD ||
    !shares.every((s) => typeof s === 'string' && s !== '')
  ) {
    throw new KeyFileError('invalid');
  }
  return { project: b.project, createdAt: b.created_at, shares: shares as string[] };
}

/** Decrypts a key file's bytes; refuses a wrong passphrase and another project's file. */
export async function decryptKeys(
  bytes: Uint8Array,
  passphrase: string,
  expectedProject: string,
): Promise<KeyRecord> {
  const head = Buffer.from(bytes.subarray(0, 64)).toString('latin1');
  if (!head.startsWith(AGE_HEADER) || !head.includes('\n-> scrypt ')) {
    throw new KeyFileError('invalid');
  }
  const d = new Decrypter();
  d.addPassphrase(passphrase);
  let text: string;
  try {
    text = await d.decrypt(bytes, 'text');
  } catch {
    // The library's message says only that no identity matched; it never holds a secret, but
    // the caller needs a code, not a text.
    throw new KeyFileError('wrong_passphrase');
  }
  const record = parseRecord(text);
  if (record.project !== expectedProject) throw new KeyFileError('project_mismatch');
  return record;
}

/**
 * Writes the ciphertext atomically, mode 600: a new temporary file in the same folder (`wx`), then
 * a rename. Never overwrites a key file.
 */
export function writeKeyFile(file: string, ciphertext: Uint8Array): void {
  if (fs.existsSync(file)) throw new KeyFileError('exists');
  const tmp = path.join(path.dirname(file), `.${KEY_FILE_NAME}.${randomBytes(6).toString('hex')}`);
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeSync(fd, ciphertext);
    fs.fsyncSync(fd);
  } catch (error) {
    fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw error;
  }
  fs.closeSync(fd);
  try {
    // `link` + `unlink` instead of `rename`: it fails when the target exists, so a file made in
    // between is never replaced.
    fs.linkSync(tmp, file);
  } catch {
    throw new KeyFileError('exists');
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Reads a key file; refuses a missing file and one others can read. */
export function readKeyFile(file: string): Uint8Array {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new KeyFileError('missing');
  }
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new KeyFileError('invalid');
  if ((stat.mode & 0o077) !== 0) throw new KeyFileError('mode');
  return fs.readFileSync(file);
}

/** Whole days since the key file was written (its time of change; the content is not read). */
export function keyFileAgeDays(file: string, now: Date): number | undefined {
  try {
    const written = fs.statSync(file).mtime.getTime();
    return Math.max(0, Math.floor((now.getTime() - written) / 86_400_000));
  } catch {
    return undefined;
  }
}
