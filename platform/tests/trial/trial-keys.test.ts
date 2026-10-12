// D-08 V08 AC1, AC4: the trial stack's key file (QUESTIONS #415, #416, #418, design/ADR-M76): the two
// unseal shares encrypted with the person's passphrase (age, scrypt), written atomically with mode
// 600, never in plaintext on the disk; the passphrase rules. Unit tests (a low scrypt work factor
// for speed, except where the default is checked).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import {
  decryptKeys,
  encryptKeys,
  KEY_FILE_NAME,
  KeyFileError,
  keyFileAgeDays,
  keyFileFor,
  readKeyFile,
  SCRYPT_LOG_N,
  writeKeyFile,
  type KeyRecord,
} from '../../deploy/trial/src/keys.js';
import {
  checkPassphrase,
  MIN_PASSPHRASE,
  PassphraseError,
  passphraseSource,
  readNewPassphrase,
  readPassphrase,
  readStdinLine,
  type PassphraseIo,
} from '../../deploy/trial/src/passphrase.js';

const FAST = 10;
const PASSPHRASE = 'correct horse battery staple';
// Built at run time: never a literal that looks like a real share.
const SHARES = [0, 1].map((i) => Buffer.alloc(32, 65 + i).toString('base64'));
const RECORD: KeyRecord = {
  project: 'sdlc-trial',
  createdAt: '2026-10-12T00:00:00.000Z',
  shares: SHARES,
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-trial-keys-'));
  dirs.push(dir);
  return dir;
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (error) {
    if (error instanceof KeyFileError) return error.code;
    throw error;
  }
  return '(none)';
}

describe('V08 AC1: the key file is age with a passphrase (scrypt)', () => {
  it('round trip: the shares come back with the right passphrase and project', async () => {
    const bytes = await encryptKeys(RECORD, PASSPHRASE, FAST);
    expect(await decryptKeys(bytes, PASSPHRASE, 'sdlc-trial')).toEqual(RECORD);
  });

  it('a wrong passphrase, another project or a file that is not age is refused', async () => {
    const bytes = await encryptKeys(RECORD, PASSPHRASE, FAST);
    expect(await code(decryptKeys(bytes, 'wrong passphrase value', 'sdlc-trial'))).toBe(
      'wrong_passphrase',
    );
    expect(await code(decryptKeys(bytes, PASSPHRASE, 'sdlc'))).toBe('project_mismatch');
    expect(await code(decryptKeys(Buffer.from('not a key file'), PASSPHRASE, 'sdlc-trial'))).toBe(
      'invalid',
    );
  });

  it('holds exactly the two shares needed, never more or an empty one', async () => {
    for (const shares of [[SHARES[0]!], [...SHARES, 'third'], [SHARES[0]!, '']]) {
      expect(await code(encryptKeys({ ...RECORD, shares }, PASSPHRASE, FAST))).toBe('invalid');
    }
  });

  it('the ciphertext is standard age with an scrypt stanza and the default work factor 18', async () => {
    expect(SCRYPT_LOG_N).toBe(18);
    const bytes = await encryptKeys(RECORD, PASSPHRASE);
    const text = Buffer.from(bytes).toString('latin1');
    expect(text.startsWith('age-encryption.org/v1\n-> scrypt ')).toBe(true);
    expect(text.split('\n')[1]).toMatch(/ 18$/);
    for (const share of SHARES) expect(text).not.toContain(share);
    expect(text).not.toContain('sdlc-trial');
  });
});

describe('V08 AC1: the file is written atomically, mode 600, never overwritten', () => {
  it('lies next to the env file and is the only file left in the folder', async () => {
    const dir = tmp();
    const file = keyFileFor(path.join(dir, '.env'));
    expect(file).toBe(path.join(dir, KEY_FILE_NAME));
    writeKeyFile(file, await encryptKeys(RECORD, PASSPHRASE, FAST));
    expect(fs.readdirSync(dir)).toEqual([KEY_FILE_NAME]);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const onDisk = fs.readFileSync(file).toString('latin1');
    for (const share of SHARES) expect(onDisk).not.toContain(share);
    expect(onDisk).not.toContain(PASSPHRASE);
    expect(await decryptKeys(readKeyFile(file), PASSPHRASE, 'sdlc-trial')).toEqual(RECORD);
  });

  it('refuses to overwrite a key file, and leaves no temporary file behind', () => {
    const dir = tmp();
    const file = path.join(dir, KEY_FILE_NAME);
    fs.writeFileSync(file, 'earlier', { mode: 0o600 });
    expect(() => writeKeyFile(file, Buffer.from('new'))).toThrow(KeyFileError);
    expect(fs.readFileSync(file, 'utf8')).toBe('earlier');
    expect(fs.readdirSync(dir)).toEqual([KEY_FILE_NAME]);
  });

  it('reading refuses a missing file and one others can read', () => {
    const dir = tmp();
    const file = path.join(dir, KEY_FILE_NAME);
    expect(() => readKeyFile(file)).toThrow(expect.objectContaining({ code: 'missing' }));
    fs.writeFileSync(file, 'x', { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    expect(() => readKeyFile(file)).toThrow(expect.objectContaining({ code: 'mode' }));
  });

  it('its age in days comes from the file time, not its content', () => {
    const file = path.join(tmp(), KEY_FILE_NAME);
    fs.writeFileSync(file, 'x', { mode: 0o600 });
    const now = new Date('2026-10-12T00:00:00Z');
    const written = new Date(now.getTime() - 85.5 * 86_400_000);
    fs.utimesSync(file, written, written);
    expect(keyFileAgeDays(file, now)).toBe(85);
    expect(keyFileAgeDays(path.join(tmp(), 'missing'), now)).toBeUndefined();
  });
});

describe('V08 AC1: the passphrase (QUESTIONS #416)', () => {
  it('at least 12 characters, not blank, at most 1024', () => {
    expect(MIN_PASSPHRASE).toBe(12);
    expect(checkPassphrase('short')).toEqual({ ok: false, problem: 'too_short' });
    expect(checkPassphrase('            ')).toEqual({ ok: false, problem: 'blank' });
    expect(checkPassphrase('x'.repeat(1025))).toEqual({ ok: false, problem: 'too_long' });
    expect(checkPassphrase(PASSPHRASE)).toEqual({ ok: true, value: PASSPHRASE });
    // Characters, not bytes: twelve Japanese characters are enough.
    expect(checkPassphrase('合言葉は山と川と海と空です').ok).toBe(true);
  });

  it('is normalised to NFC, so a composed and a decomposed form are the same', async () => {
    const composed = 'mật khẩu thử nghiệm';
    const decomposed = composed.normalize('NFD');
    expect(decomposed).not.toBe(composed);
    const bytes = await encryptKeys(
      RECORD,
      (checkPassphrase(composed) as { value: string }).value,
      FAST,
    );
    const io = fakeIo([decomposed]);
    const again = await readPassphrase('tty', io);
    expect(await decryptKeys(bytes, again, 'sdlc-trial')).toEqual(RECORD);
  });

  it('a terminal asks twice; a mismatch asks again, three tries at most', async () => {
    const io = fakeIo([PASSPHRASE, 'something else 1', PASSPHRASE, PASSPHRASE]);
    expect(await readNewPassphrase('tty', io)).toBe(PASSPHRASE);
    expect(io.warnings).toEqual(['trial.passphrase.mismatch']);
    const never = fakeIo(['short', 'short', 'short']);
    await expect(readNewPassphrase('tty', never)).rejects.toBeInstanceOf(PassphraseError);
  });

  it('--passphrase-stdin reads the first line once; no terminal and no flag is refused', async () => {
    expect(await readNewPassphrase('stdin', fakeIo([], `${PASSPHRASE}\nignored\n`))).toBe(
      PASSPHRASE,
    );
    await expect(readNewPassphrase('stdin', fakeIo([], 'short\n'))).rejects.toMatchObject({
      problem: 'too_short',
    });
    expect(passphraseSource(true, false)).toBe('tty');
    expect(passphraseSource(false, true)).toBe('stdin');
    expect(passphraseSource(true, true)).toBe('stdin');
    expect(passphraseSource(false, false)).toBe('none');
  });

  it('readStdinLine stops at the first line end and drops a carriage return', async () => {
    expect(await readStdinLine(Readable.from([Buffer.from('first line\r\nsecond\n')]))).toBe(
      'first line',
    );
    expect(await readStdinLine(Readable.from([Buffer.from('no newline')]))).toBe('no newline');
  });
});

function fakeIo(hidden: string[], stdin = ''): PassphraseIo & { warnings: string[] } {
  const queue = [...hidden];
  const warnings: string[] = [];
  return {
    warnings,
    hidden: () => Promise.resolve(queue.shift() ?? ''),
    stdinLine: () => readStdinLine(Readable.from([Buffer.from(stdin)])),
    text: (key) => key,
    warn: (line) => warnings.push(line),
  };
}
