// The passphrase of the trial stack's key file (D-08 V08 AC1, QUESTIONS #416): a hidden prompt on
// a terminal (twice for a new one), or the first line of standard input with
// `--passphrase-stdin`; never an argument or an environment variable (both show in `ps`). At
// least 12 characters, normalised to Unicode NFC, so the same passphrase typed with another input
// method works. Never logged.
import type { MessageKey } from '@sdlc/messages';

export const MIN_PASSPHRASE = 12;
export const MAX_PASSPHRASE = 1024;
/** Tries on a terminal (a mismatch when choosing it, a wrong one when starting). */
export const PASSPHRASE_TRIES = 3;

export type PassphraseProblem = 'blank' | 'too_short' | 'too_long';

/** The normalised passphrase, or what is wrong with it. Pure. */
export function checkPassphrase(
  raw: string,
):
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly problem: PassphraseProblem } {
  const value = raw.normalize('NFC');
  if (value.trim() === '') return { ok: false, problem: 'blank' };
  const length = [...value].length;
  if (length < MIN_PASSPHRASE) return { ok: false, problem: 'too_short' };
  if (length > MAX_PASSPHRASE) return { ok: false, problem: 'too_long' };
  return { ok: true, value };
}

/** Where the passphrase comes from. `none`: no terminal and no `--passphrase-stdin`. Pure. */
export function passphraseSource(
  stdinIsTTY: boolean,
  fromStdin: boolean,
): 'tty' | 'stdin' | 'none' {
  if (fromStdin) return 'stdin';
  return stdinIsTTY ? 'tty' : 'none';
}

export interface PassphraseIo {
  /** One hidden line from the terminal. */
  readonly hidden: (prompt: string) => Promise<string>;
  /** The first line of standard input. */
  readonly stdinLine: () => Promise<string>;
  readonly text: (key: MessageKey, params?: Readonly<Record<string, string | number>>) => string;
  readonly warn: (line: string) => void;
}

/** Thrown when no usable passphrase was given; the caller prints its catalog message. */
export class PassphraseError extends Error {
  constructor(readonly problem: PassphraseProblem | 'mismatch' | 'aborted') {
    super(`passphrase: ${problem}`);
  }
}

/** The catalog message of each passphrase problem. */
export const PASSPHRASE_PROBLEM_KEYS = {
  blank: 'trial.passphrase.blank',
  too_short: 'trial.passphrase.too_short',
  too_long: 'trial.passphrase.too_long',
  mismatch: 'trial.passphrase.mismatch',
  aborted: 'trial.passphrase.aborted',
} as const satisfies Record<PassphraseError['problem'], MessageKey>;

const problemKey = (p: PassphraseProblem): MessageKey => PASSPHRASE_PROBLEM_KEYS[p];

/** A new passphrase for `trial:up`: twice on a terminal, once from standard input. */
export async function readNewPassphrase(
  source: 'tty' | 'stdin',
  io: PassphraseIo,
): Promise<string> {
  if (source === 'stdin') {
    const checked = checkPassphrase(await io.stdinLine());
    if (!checked.ok) throw new PassphraseError(checked.problem);
    return checked.value;
  }
  let last: PassphraseError = new PassphraseError('aborted');
  for (let i = 0; i < PASSPHRASE_TRIES; i += 1) {
    const first = checkPassphrase(await io.hidden(io.text('trial.passphrase.prompt_new')));
    if (!first.ok) {
      io.warn(io.text(problemKey(first.problem), { min: MIN_PASSPHRASE }));
      last = new PassphraseError(first.problem);
      continue;
    }
    const again = (await io.hidden(io.text('trial.passphrase.prompt_again'))).normalize('NFC');
    if (again === first.value) return first.value;
    io.warn(io.text(PASSPHRASE_PROBLEM_KEYS.mismatch));
    last = new PassphraseError('mismatch');
  }
  throw last;
}

/** A passphrase for `trial:start`: one hidden line, or the first line of standard input. */
export async function readPassphrase(source: 'tty' | 'stdin', io: PassphraseIo): Promise<string> {
  const raw =
    source === 'stdin' ? await io.stdinLine() : await io.hidden(io.text('trial.passphrase.prompt'));
  return raw.normalize('NFC');
}

/** Reads standard input up to its first line end (at most 4 KiB), then stops reading. */
export async function readStdinLine(stdin: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stdin as AsyncIterable<Buffer | string>) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    size += buf.length;
    chunks.push(buf);
    if (buf.includes(0x0a) || size > 4096) break;
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const end = text.indexOf('\n');
  return (end >= 0 ? text.slice(0, end) : text).replace(/\r$/, '');
}
