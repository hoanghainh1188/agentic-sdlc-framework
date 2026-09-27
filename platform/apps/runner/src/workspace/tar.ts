// POSIX tar writer for the workspace upload (ADR-M25 §2.3). Every entry belongs to the sandbox
// user (10001:10001), so the agent can write its workspace; nothing from the runner's host (user
// names, owners, times, modes other than "executable or not") goes into the archive.
//
// - Directories, regular files and symbolic links. Anything else (hard links, devices, FIFOs,
//   sockets) makes packing fail: a repository never needs them.
// - A symbolic link is stored as a link entry (its target path) only. Its target is never read or
//   followed, wherever it points (`/etc/passwd`, `../..`, the runner's own files): the runner
//   uses lstat, never descends into a linked directory, and opens files with O_NOFOLLOW.
// - Every entry path is relative and stays inside the workspace after normalisation.
// - Names or link targets longer than the ustar fields use a PAX extended header (`x`).
import fs from 'node:fs';
import path from 'node:path';

import { RunnerError } from '../errors.js';

export const SANDBOX_UID = 10001;
const BLOCK = 512;
/** Fixed modification time (2026-01-01T00:00:00Z): the archive depends on the content only. */
const MTIME = 1_767_225_600;

export type TarEntry =
  | { readonly type: 'dir'; readonly path: string }
  | {
      readonly type: 'file';
      readonly path: string;
      readonly content: Buffer;
      readonly executable?: boolean;
    }
  | { readonly type: 'symlink'; readonly path: string; readonly target: string };

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, '0') + '\0';
}

function checkPath(p: string): string {
  const parts = p.split('/');
  if (
    p.length === 0 ||
    p.startsWith('/') ||
    parts.some((part) => part === '..' || part === '') ||
    /[\0\n\\]/.test(p) ||
    // Normalised, the path must be itself: no `.` segments except the root entry `.`.
    (p !== '.' && path.posix.normalize(p) !== p)
  ) {
    throw new TypeError('tar entry paths must be relative, normalised, inside the workspace');
  }
  return p;
}

function header(name: string, type: string, mode: number, size: number, linkname = ''): Buffer {
  const buf = Buffer.alloc(BLOCK, 0);
  buf.write(name, 0, 100, 'utf8');
  buf.write(octal(mode, 8), 100, 'ascii');
  buf.write(octal(SANDBOX_UID, 8), 108, 'ascii');
  buf.write(octal(SANDBOX_UID, 8), 116, 'ascii');
  buf.write(octal(size, 12), 124, 'ascii');
  buf.write(octal(MTIME, 12), 136, 'ascii');
  buf.write('        ', 148, 'ascii'); // checksum placeholder
  buf.write(type, 156, 'ascii');
  buf.write(linkname, 157, 100, 'utf8');
  buf.write('ustar\0', 257, 'ascii');
  buf.write('00', 263, 'ascii');
  let sum = 0;
  for (const byte of buf) sum += byte;
  buf.write(octal(sum, 7) + ' ', 148, 'ascii');
  return buf;
}

function padded(content: Buffer): Buffer[] {
  const padding = (BLOCK - (content.length % BLOCK)) % BLOCK;
  return padding > 0 ? [content, Buffer.alloc(padding, 0)] : [content];
}

/** One PAX record: "<length> <key>=<value>\n", where the length counts the whole record. */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  const bodyLength = Buffer.byteLength(body);
  let length = bodyLength + 1;
  while (String(length).length + bodyLength !== length) {
    length = String(length).length + bodyLength;
  }
  return `${String(length)}${body}`;
}

function entryBlocks(entry: TarEntry): Buffer[] {
  const name = checkPath(entry.path) + (entry.type === 'dir' ? '/' : '');
  const target = entry.type === 'symlink' ? entry.target : '';
  if (entry.type === 'symlink' && (target === '' || /[\0\n]/.test(target))) {
    throw new TypeError('symbolic link targets must be non-empty, without line breaks');
  }
  const pax: string[] = [];
  if (Buffer.byteLength(name) > 100) pax.push(paxRecord('path', name));
  if (Buffer.byteLength(target) > 100) pax.push(paxRecord('linkpath', target));
  const blocks: Buffer[] = [];
  if (pax.length > 0) {
    const records = Buffer.from(pax.join(''), 'utf8');
    blocks.push(header('././@PaxHeader', 'x', 0o644, records.length), ...padded(records));
  }
  const shortName = Buffer.byteLength(name) > 100 ? 'pax-long-name' : name;
  const shortTarget = Buffer.byteLength(target) > 100 ? 'pax-long-link' : target;
  switch (entry.type) {
    case 'dir':
      blocks.push(header(shortName, '5', 0o755, 0));
      break;
    case 'symlink':
      blocks.push(header(shortName, '2', 0o777, 0, shortTarget));
      break;
    case 'file':
      blocks.push(
        header(shortName, '0', entry.executable ? 0o755 : 0o644, entry.content.length),
        ...padded(entry.content),
      );
      break;
  }
  return blocks;
}

/** Packs entries into a tar archive (two zero blocks at the end). */
export function packTar(entries: readonly TarEntry[]): Buffer {
  const parts = entries.flatMap(entryBlocks);
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(parts);
}

/**
 * Packs a directory (the cloned repository, `.git` included) with `.` as its root entry. Refuses
 * special files, and a total content size above `maxBytes` (`workspace_too_large`).
 */
export function packDirectory(root: string, maxBytes: number): Buffer {
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory()) throw new RunnerError('runner.workspace.special_file');
  const realRoot = path.resolve(root);
  const entries: TarEntry[] = [{ type: 'dir', path: '.' }];
  let total = 0;
  const walk = (dir: string, prefix: string): void => {
    const names = fs.readdirSync(dir).sort();
    for (const name of names) {
      const full = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      insideWorkspace(realRoot, full, rel);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) {
        // The link itself, never its target.
        entries.push({ type: 'symlink', path: rel, target: fs.readlinkSync(full) });
      } else if (stat.isDirectory()) {
        entries.push({ type: 'dir', path: rel });
        walk(full, rel);
      } else if (stat.isFile()) {
        if (stat.nlink > 1) throw new RunnerError('runner.workspace.special_file');
        total += stat.size;
        if (total > maxBytes) throw new RunnerError('runner.workspace.too_large');
        entries.push({
          type: 'file',
          path: rel,
          content: readRegularFile(full, stat),
          executable: (stat.mode & 0o111) !== 0,
        });
      } else {
        throw new RunnerError('runner.workspace.special_file');
      }
    }
  };
  walk(realRoot, '');
  return packTar(entries);
}

/** Refuses an entry whose path would leave the workspace after normalisation. */
function insideWorkspace(root: string, full: string, rel: string): void {
  const resolved = path.resolve(full);
  if (
    !resolved.startsWith(root + path.sep) ||
    path.relative(root, resolved) !== rel.split('/').join(path.sep)
  ) {
    throw new RunnerError('runner.workspace.path_escape');
  }
  try {
    checkPath(rel);
  } catch {
    throw new RunnerError('runner.workspace.path_escape');
  }
}

/**
 * Reads a regular file without following a symbolic link: O_NOFOLLOW, then the open file must be
 * the same regular file the walk saw (device and inode), so a swap after `lstat` is refused.
 */
function readRegularFile(full: string, seen: fs.Stats): Buffer {
  let fd: number;
  try {
    fd = fs.openSync(full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    throw new RunnerError('runner.workspace.special_file');
  }
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.ino !== seen.ino || opened.dev !== seen.dev) {
      throw new RunnerError('runner.workspace.special_file');
    }
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
