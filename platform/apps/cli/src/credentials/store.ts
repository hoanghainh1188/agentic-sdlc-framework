// The saved login of `adlc login` (design/ADR-M36 §2.1): `<config>/adlc/credentials.json`, where
// <config> is $XDG_CONFIG_HOME or ~/.config. The token is stored in plain text, so the folder is
// mode 700 and the file mode 600, written through a temporary file that is never readable by
// others; a file that group or others can read is refused, like ssh does.
// ADR-M100 §2.3: until the new file exists, the login of the old command, `<config>/sdlc/`, is read
// with the same checks, so nobody logs in again; a save writes the new folder only, and a logout
// deletes both.
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { z } from 'zod';

import { isApiToken, normaliseApiUrl } from './settings.js';

export interface SavedLogin {
  readonly apiUrl: string;
  readonly token: string;
}

export type CredentialsProblem =
  'no_config_dir' | 'unsafe_mode' | 'not_a_file' | 'not_owner' | 'malformed';

export class CredentialsError extends Error {
  constructor(
    readonly problem: CredentialsProblem,
    readonly path: string,
  ) {
    super(`credentials_${problem}`);
  }
}

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const MAX_FILE_BYTES = 4096;
const TEMP_FILE = /^\.credentials\.[0-9a-f]{16}\.tmp$/;

const fileSchema = z.strictObject({
  version: z.literal(1),
  api_url: z.string().max(512),
  token: z.string().max(128),
});

const FOLDER = 'adlc';
/** The folder of the command `sdlc` before v0.9.0 (ADR-M100 §2.3): read only, never written. */
const LEGACY_FOLDER = 'sdlc';
const FILE_NAME = 'credentials.json';

/** $XDG_CONFIG_HOME or ~/.config. Throws when there is no usable home folder. */
function configHome(env: Readonly<Record<string, string | undefined>>): string {
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg !== '' && isAbsolute(xdg)) return xdg;
  const home = env.HOME;
  if (home !== undefined && home !== '' && isAbsolute(home)) return join(home, '.config');
  throw new CredentialsError('no_config_dir', '');
}

/** The folder of the saved login, from the environment. */
export function credentialsDir(env: Readonly<Record<string, string | undefined>>): string {
  return join(configHome(env), FOLDER);
}

/** The folder of the old command's saved login (ADR-M100 §2.3). */
export function legacyCredentialsDir(env: Readonly<Record<string, string | undefined>>): string {
  return join(configHome(env), LEGACY_FOLDER);
}

export function credentialsPath(env: Readonly<Record<string, string | undefined>>): string {
  return join(credentialsDir(env), FILE_NAME);
}

/**
 * Reads the saved login: the new file, or the old command's file while the new one does not exist.
 * Undefined when there is none. Throws `CredentialsError` when unsafe.
 */
export async function readSavedLogin(
  env: Readonly<Record<string, string | undefined>>,
): Promise<SavedLogin | undefined> {
  const current = await readLoginFile(credentialsPath(env));
  if (current !== undefined) return current;
  return readLoginFile(join(legacyCredentialsDir(env), FILE_NAME));
}

async function readLoginFile(path: string): Promise<SavedLogin | undefined> {
  let handle;
  try {
    // O_NOFOLLOW: a symbolic link is refused (ELOOP); the checks below run on the opened file.
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new CredentialsError('not_a_file', path);
    }
    throw error;
  }
  let text: string;
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new CredentialsError('not_a_file', path);
    if ((stats.mode & 0o077) !== 0) throw new CredentialsError('unsafe_mode', path);
    if (!ownedByMe(stats.uid)) throw new CredentialsError('not_owner', path);
    if (stats.size > MAX_FILE_BYTES) throw new CredentialsError('malformed', path);
    text = await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
  let parsed;
  try {
    parsed = fileSchema.parse(JSON.parse(text));
  } catch {
    throw new CredentialsError('malformed', path);
  }
  const url = normaliseApiUrl(parsed.api_url);
  if (!('url' in url) || !isApiToken(parsed.token)) {
    throw new CredentialsError('malformed', path);
  }
  return { apiUrl: url.url, token: parsed.token };
}

/** Saves the login: folder mode 700, file mode 600, replaced atomically. Returns the path. */
export async function writeSavedLogin(
  env: Readonly<Record<string, string | undefined>>,
  login: SavedLogin,
): Promise<string> {
  const dir = credentialsDir(env);
  await mkdir(dir, { recursive: true, mode: DIR_MODE });
  // The folder must be a real folder of this user, not a link to somewhere else.
  const stats = await lstat(dir);
  if (!stats.isDirectory()) throw new CredentialsError('not_a_file', dir);
  if (!ownedByMe(stats.uid)) throw new CredentialsError('not_owner', dir);
  await chmod(dir, DIR_MODE);
  const path = join(dir, FILE_NAME);
  const temp = join(dir, `.credentials.${randomBytes(8).toString('hex')}.tmp`);
  const body = `${JSON.stringify({ version: 1, api_url: login.apiUrl, token: login.token }, null, 2)}\n`;
  const handle = await open(temp, 'wx', FILE_MODE);
  try {
    await handle.writeFile(body, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
  return path;
}

/**
 * Deletes the saved login in the new and the old folder (ADR-M100 §2.3), and temporary files a
 * killed `adlc login` left. False: there was none.
 */
export async function deleteSavedLogin(
  env: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  const deleted = await Promise.all([
    deleteLoginIn(credentialsDir(env)),
    deleteLoginIn(legacyCredentialsDir(env)),
  ]);
  return deleted.includes(true);
}

async function deleteLoginIn(dir: string): Promise<boolean> {
  const names = await readdir(dir).catch((error: unknown) => {
    if (isNotFound(error)) return [] as string[];
    throw error;
  });
  await Promise.all(
    names.filter((name) => TEMP_FILE.test(name)).map((name) => unlink(join(dir, name))),
  );
  try {
    await unlink(join(dir, FILE_NAME));
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

function ownedByMe(uid: number): boolean {
  const me = process.getuid?.();
  return me === undefined || uid === me;
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}
