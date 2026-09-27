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
// - Caps: the total size of file contents and the number of entries.
// - Header checksums are verified; PAX (`x`) and GNU long names (`L`, `K`) are read, global PAX
//   headers (`g`) ignored.
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
  /** Sum of file contents, in bytes. */
  readonly maxBytes: number;
  readonly maxEntries: number;
}

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

/**
 * Parses the archive of `root` (the folder Docker puts at the top, `workspace` for `/workspace`).
 * Returns the entries under it, in archive order, `.git` paths left out.
 */
export function untarWorkspace(
  archive: Buffer,
  root: string,
  limits: UntarLimits,
): WorkspaceEntry[] {
  const entries: WorkspaceEntry[] = [];
  let total = 0;
  let count = 0;
  let at = 0;
  let longName: string | undefined;
  let longLink: string | undefined;
  let pax: Record<string, string> = {};
  for (;;) {
    if (at + BLOCK > archive.length) throw invalid();
    const header = archive.subarray(at, at + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    if (!checksumOk(header)) throw invalid();
    const type = String.fromCharCode(header[156]!);
    const size = octal(header, 124, 12);
    const dataStart = at + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > archive.length) throw invalid();
    const data = archive.subarray(dataStart, dataEnd);
    at = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === 'x') {
      pax = paxRecords(data);
      continue;
    }
    if (type === 'g') continue;
    if (type === 'L') {
      longName = data.toString('utf8').replace(/\0+$/, '');
      continue;
    }
    if (type === 'K') {
      longLink = data.toString('utf8').replace(/\0+$/, '');
      continue;
    }

    count += 1;
    if (count > limits.maxEntries) throw new RunnerError('runner.workspace.too_large');
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
    if (rel === null || isGitPath(rel)) continue;
    if (type === '5') {
      entries.push({ type: 'dir', path: rel });
    } else if (type === '2') {
      if (link.length === 0 || link.length > 4096 || link.includes('\0')) throw invalid();
      entries.push({ type: 'symlink', path: rel, target: link });
    } else {
      total += size;
      if (total > limits.maxBytes) throw new RunnerError('runner.workspace.too_large');
      entries.push({
        type: 'file',
        path: rel,
        content: Buffer.from(data),
        executable: (mode & 0o111) !== 0,
      });
    }
  }
  return entries;
}
