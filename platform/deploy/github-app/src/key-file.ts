// The private key's file (D-08 V03): outside the repository, mode 600, never over an existing file
// without --force, never through a symbolic link. Written to a new temporary file in the same
// folder, then renamed over the target in one step.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type KeyFileRefusal = 'in_repo' | 'no_folder' | 'exists' | 'not_a_file';

// macOS and Windows file systems ignore case: compare paths the same way there.
const fold = (p: string): string =>
  process.platform === 'darwin' || process.platform === 'win32' ? p.toLowerCase() : p;

const inside = (child: string, parent: string): boolean => {
  const rel = path.relative(fold(parent), fold(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** Why the key may not be written to `file`, or undefined. `file` is an absolute path. */
export function keyFileRefusal(
  file: string,
  repoRoot: string,
  force: boolean,
): KeyFileRefusal | undefined {
  const folder = path.dirname(file);
  let realFolder: string;
  try {
    realFolder = fs.realpathSync.native(folder);
    if (!fs.statSync(realFolder).isDirectory()) return 'no_folder';
  } catch {
    return 'no_folder';
  }
  const realRoot = fs.realpathSync.native(repoRoot);
  if (inside(file, repoRoot) || inside(path.join(realFolder, path.basename(file)), realRoot))
    return 'in_repo';
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return undefined;
  }
  if (!force) return 'exists';
  // --force replaces a regular file only: never a link, a folder or a device.
  return stat.isFile() ? undefined : 'not_a_file';
}

/** Writes the key with mode 600 and renames it into place. Checks `keyFileRefusal` again first. */
export function writeKeyFile(file: string, pem: string, repoRoot: string, force: boolean): void {
  const refusal = keyFileRefusal(file, repoRoot, force);
  if (refusal) throw new KeyFileError(refusal);
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`,
  );
  // `wx`: a new file only, so a link planted at the temporary name is never followed.
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, pem);
    fs.fsyncSync(fd);
    fs.fchmodSync(fd, 0o600);
  } catch (error) {
    fs.closeSync(fd);
    fs.rmSync(temp, { force: true });
    throw error;
  }
  fs.closeSync(fd);
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

export class KeyFileError extends Error {
  constructor(readonly refusal: KeyFileRefusal) {
    super(refusal);
  }
}
