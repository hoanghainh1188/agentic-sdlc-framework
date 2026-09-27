// Minimal POSIX ustar writer for the workspace upload (ADR-M25 §2.3). Every entry belongs to the
// sandbox user (10001:10001), so the agent can write its workspace; nothing from the runner's
// host (user names, times, modes beyond the listed ones) goes into the archive.
//
// Session 1 packs in-memory entries (tests). Session 2 adds packing a cloned directory, symbolic
// links and long names (PAX headers).

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
    };

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, '0') + '\0';
}

function checkPath(path: string): string {
  const parts = path.split('/');
  if (
    path.length === 0 ||
    Buffer.byteLength(path) > 100 ||
    path.startsWith('/') ||
    parts.some((part) => part === '..' || part === '') ||
    /[\0\n]/.test(path)
  ) {
    throw new TypeError('tar entry paths must be relative, without "..", at most 100 bytes');
  }
  return path;
}

function header(entry: TarEntry, size: number): Buffer {
  const buf = Buffer.alloc(BLOCK, 0);
  const name = checkPath(entry.path) + (entry.type === 'dir' ? '/' : '');
  const mode = entry.type === 'dir' || entry.executable ? 0o755 : 0o644;
  buf.write(name, 0, 100, 'utf8');
  buf.write(octal(mode, 8), 100, 'ascii');
  buf.write(octal(SANDBOX_UID, 8), 108, 'ascii');
  buf.write(octal(SANDBOX_UID, 8), 116, 'ascii');
  buf.write(octal(size, 12), 124, 'ascii');
  buf.write(octal(MTIME, 12), 136, 'ascii');
  buf.write('        ', 148, 'ascii'); // checksum placeholder
  buf.write(entry.type === 'dir' ? '5' : '0', 156, 'ascii');
  buf.write('ustar\0', 257, 'ascii');
  buf.write('00', 263, 'ascii');
  let sum = 0;
  for (const byte of buf) sum += byte;
  buf.write(octal(sum, 7) + ' ', 148, 'ascii');
  return buf;
}

/** Packs entries into a tar archive (two zero blocks at the end). */
export function packTar(entries: readonly TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const content = entry.type === 'file' ? entry.content : Buffer.alloc(0);
    parts.push(header(entry, content.length), content);
    const padding = (BLOCK - (content.length % BLOCK)) % BLOCK;
    if (padding > 0) parts.push(Buffer.alloc(padding, 0));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(parts);
}
