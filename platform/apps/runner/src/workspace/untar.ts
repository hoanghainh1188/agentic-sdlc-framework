// Reads the tar archive Docker returns for the sandbox's `/workspace` (task C06 session 2b,
// design/ADR-M33 §2.9). The archive comes from the sandbox, which the agent controls: it is
// untrusted input.
//
// - Accepted: directories, regular files and symbolic links (kept as links: the target is only a
//   string, never resolved or followed). Refused: hard links, character and block devices, FIFOs,
//   anything else, and paths that are absolute, contain `..`, NUL or backslash, or do not stay
//   under the archive's root folder.
// - Every path with a `.git` segment is skipped: the runner's own `.git` is the reference, the
//   agent's is never read. Segments are compared folded (`foldSegment`: NFC, invisible characters
//   removed, lower case), so `.GIT` or `.g\u200cit` is `.git` too: on a case-insensitive or
//   normalising file system (macOS) they would name the runner's real `.git` (security review).
// - The archive is read as a stream, never held whole in memory (Harry's review of PR #112: a real
//   workspace holds `node_modules`). A `filter` decides per entry before its content is read:
//   skipped files are read past, never copied; a skipped directory skips everything under it.
//   Kept file contents are copied once, into a buffer of the file's size.
// - Caps: the bytes streamed (`maxStreamBytes`), the total size of kept file contents and the
//   number of kept entries.
// - Header checksums are verified; PAX (`x`) and GNU long names (`L`, `K`, at most 64 KiB) are
//   read, global PAX headers (`g`) ignored.
import path from 'node:path';

import { RunnerError } from '../errors.js';

export type WorkspaceEntry =
  | { readonly type: 'dir'; readonly path: string }
  | {
      readonly type: 'file';
      readonly path: string;
      readonly content: Buffer;
      readonly executable: boolean;
    }
  | { readonly type: 'symlink'; readonly path: string; readonly target: string };

export interface UntarLimits {
  /** Sum of the kept file contents, in bytes. */
  readonly maxBytes: number;
  /** Number of kept entries. */
  readonly maxEntries: number;
  /** Bytes read from the archive stream, skipped entries included. Default: `maxBytes` × 4. */
  readonly maxStreamBytes?: number;
}

/** What to do with an entry: keep it, skip it, or (a directory) skip it and everything under it. */
export type EntryDecision = 'keep' | 'skip' | 'skip_tree';

/** Decides before the content is read. `path` is relative to the root; `.git` never reaches it. */
export type EntryFilter = (
  path: string,
  type: WorkspaceEntry['type'],
) => EntryDecision | Promise<EntryDecision>;

const BLOCK = 512;

function invalid(): RunnerError {
  return new RunnerError('runner.workspace.archive_invalid');
}

function field(header: Buffer, start: number, length: number): string {
  const raw = header.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? length : end).toString('utf8');
}

function octal(header: Buffer, start: number, length: number): number {
  // Base-256 sizes (first byte 0x80) are for files above 8 GiB: never valid here.
  if ((header[start]! & 0x80) !== 0) throw invalid();
  const text = field(header, start, length).trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) throw invalid();
  const value = parseInt(text, 8);
  if (!Number.isSafeInteger(value)) throw invalid();
  return value;
}

function checksumOk(header: Buffer): boolean {
  const stored = octal(header, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += i >= 148 && i < 156 ? 0x20 : header[i]!;
  return sum === stored;
}

/** PAX records: `<length> <key>=<value>\n`. Only `path` and `linkpath` matter. */
function paxRecords(data: Buffer): Record<string, string> {
  const records: Record<string, string> = {};
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space === -1) throw invalid();
    const length = Number(data.subarray(at, space).toString('ascii'));
    if (!Number.isSafeInteger(length) || length <= 0 || at + length > data.length) throw invalid();
    const record = data.subarray(space + 1, at + length - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq === -1) throw invalid();
    records[record.slice(0, eq)] = record.slice(eq + 1);
    at += length;
  }
  return records;
}

/** The path under the root folder, or null for the root itself. Throws when it escapes. */
function relative(name: string, root: string): string | null {
  const trimmed = name.replace(/\/+$/, '');
  if (trimmed === root || trimmed === `./${root}`) return null;
  const withoutDot = trimmed.startsWith('./') ? trimmed.slice(2) : trimmed;
  if (!withoutDot.startsWith(`${root}/`)) throw invalid();
  const rest = withoutDot.slice(root.length + 1);
  const parts = rest.split('/');
  if (
    rest.length === 0 ||
    rest.length > 4096 ||
    /[\0\\]/.test(rest) ||
    parts.some((part) => part === '' || part === '.' || part === '..') ||
    path.posix.normalize(rest) !== rest
  ) {
    throw invalid();
  }
  return rest;
}

/** Characters that some file systems ignore in names (HFS+, APFS): zero-width, bidi, BOM. */
const IGNORABLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;

/** How a case-insensitive, normalising file system may see one path segment. */
export function foldSegment(segment: string): string {
  return segment.normalize('NFC').replace(IGNORABLE, '').toLowerCase();
}

/** The folded path: two paths with the same fold may be one file on disk. */
export function foldPath(p: string): string {
  return p.split('/').map(foldSegment).join('/');
}

export function isGitPath(p: string): boolean {
  return p.split('/').some((segment) => foldSegment(segment) === '.git');
}

/** Reads exact byte counts from a stream of chunks; counts every byte against a cap. */
class ByteReader {
  readonly #chunks: AsyncIterator<Buffer> | Iterator<Buffer>;
  readonly #max: number;
  #chunk: Buffer = Buffer.alloc(0);
  #pos = 0;
  #total = 0;

  constructor(source: AsyncIterable<Buffer> | Iterable<Buffer>, max: number) {
    this.#chunks =
      Symbol.asyncIterator in source ? source[Symbol.asyncIterator]() : source[Symbol.iterator]();
    this.#max = max;
  }

  async #next(): Promise<boolean> {
    for (;;) {
      const next = await this.#chunks.next();
      if (next.done) return false;
      const chunk = next.value;
      this.#total += chunk.length;
      if (this.#total > this.#max) throw new RunnerError('runner.workspace.too_large');
      if (chunk.length === 0) continue;
      this.#chunk = chunk;
      this.#pos = 0;
      return true;
    }
  }

  /** Exactly `n` bytes, copied once into a new buffer. */
  async read(n: number): Promise<Buffer> {
    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    while (filled < n) {
      if (this.#pos >= this.#chunk.length && !(await this.#next())) throw invalid();
      const take = Math.min(n - filled, this.#chunk.length - this.#pos);
      this.#chunk.copy(out, filled, this.#pos, this.#pos + take);
      this.#pos += take;
      filled += take;
    }
    return out;
  }

  async skip(n: number): Promise<void> {
    let left = n;
    while (left > 0) {
      if (this.#pos >= this.#chunk.length && !(await this.#next())) throw invalid();
      const take = Math.min(left, this.#chunk.length - this.#pos);
      this.#pos += take;
      left -= take;
    }
  }
}

/** Long names and PAX records are small; anything bigger is not an archive Docker writes. */
const MAX_META_BYTES = 64 * 1024;

const keepAll: EntryFilter = () => 'keep';

/**
 * Parses the archive of `root` (the folder Docker puts at the top, `workspace` for `/workspace`).
 * Returns the kept entries under it, in archive order, `.git` paths left out.
 */
export async function untarWorkspace(
  archive: AsyncIterable<Buffer> | Iterable<Buffer> | Buffer,
  root: string,
  limits: UntarLimits,
  filter: EntryFilter = keepAll,
): Promise<WorkspaceEntry[]> {
  const reader = new ByteReader(
    Buffer.isBuffer(archive) ? [archive] : archive,
    limits.maxStreamBytes ?? limits.maxBytes * 4,
  );
  const entries: WorkspaceEntry[] = [];
  const skippedTrees: string[] = [];
  let total = 0;
  let count = 0;
  let longName: string | undefined;
  let longLink: string | undefined;
  let pax: Record<string, string> = {};
  for (;;) {
    const header = await reader.read(BLOCK);
    if (header.every((byte) => byte === 0)) break;
    if (!checksumOk(header)) throw invalid();
    const type = String.fromCharCode(header[156]!);
    const size = octal(header, 124, 12);
    const padded = Math.ceil(size / BLOCK) * BLOCK;

    if (type === 'x' || type === 'L' || type === 'K') {
      if (size > MAX_META_BYTES) throw invalid();
      const data = (await reader.read(padded)).subarray(0, size);
      if (type === 'x') pax = paxRecords(data);
      else if (type === 'L') longName = data.toString('utf8').replace(/\0+$/, '');
      else longLink = data.toString('utf8').replace(/\0+$/, '');
      continue;
    }
    if (type === 'g') {
      await reader.skip(padded);
      continue;
    }

    const prefix = field(header, 345, 155);
    const shortName = field(header, 0, 100);
    const name = pax.path ?? longName ?? (prefix ? `${prefix}/${shortName}` : shortName);
    const link = pax.linkpath ?? longLink ?? field(header, 157, 100);
    const mode = octal(header, 100, 8);
    pax = {};
    longName = undefined;
    longLink = undefined;

    if (!['0', '\0', '5', '2'].includes(type)) {
      // Hard links, devices, FIFOs and unknown types are never part of a repository.
      throw new RunnerError('runner.workspace.special_file');
    }
    const rel = relative(name, root);
    const kind: WorkspaceEntry['type'] = type === '5' ? 'dir' : type === '2' ? 'symlink' : 'file';
    const decision =
      rel === null || isGitPath(rel) || skippedTrees.some((tree) => rel.startsWith(tree))
        ? 'skip'
        : await filter(rel, kind);
    if (decision !== 'keep') {
      if (decision === 'skip_tree' && kind === 'dir') skippedTrees.push(`${rel!}/`);
      await reader.skip(padded);
      continue;
    }

    count += 1;
    if (count > limits.maxEntries) throw new RunnerError('runner.workspace.too_large');
    if (kind === 'dir') {
      await reader.skip(padded);
      entries.push({ type: 'dir', path: rel! });
    } else if (kind === 'symlink') {
      await reader.skip(padded);
      if (link.length === 0 || link.length > 4096 || link.includes('\0')) throw invalid();
      entries.push({ type: 'symlink', path: rel!, target: link });
    } else {
      total += size;
      if (total > limits.maxBytes) throw new RunnerError('runner.workspace.too_large');
      const content = await reader.read(size);
      await reader.skip(padded - size);
      entries.push({ type: 'file', path: rel!, content, executable: (mode & 0o111) !== 0 });
    }
  }
  return entries;
}
