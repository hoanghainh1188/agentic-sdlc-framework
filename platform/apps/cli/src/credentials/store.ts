// The saved login of `sdlc login` (design/ADR-M36 §2.1): `<config>/sdlc/credentials.json`, where
// <config> is $XDG_CONFIG_HOME or ~/.config. The token is stored in plain text, so the folder is
// mode 700 and the file mode 600, written through a temporary file that is never readable by
// others; a file that group or others can read is refused, like ssh does.
import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
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

const fileSchema = z.strictObject({
  version: z.literal(1),
  api_url: z.string().max(512),
  token: z.string().max(128),
});

/** The folder of the saved login, from the environment. Undefined: no usable home folder. */
export function credentialsDir(env: Readonly<Record<string, string | undefined>>): string {
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg !== '' && isAbsolute(xdg)) return join(xdg, 'sdlc');
  const home = env.HOME;
  if (home !== undefined && home !== '' && isAbsolute(home)) return join(home, '.config', 'sdlc');
  throw new CredentialsError('no_config_dir', '');
}

export function credentialsPath(env: Readonly<Record<string, string | undefined>>): string {
  return join(credentialsDir(env), 'credentials.json');
}

/** Reads the saved login. Undefined when there is none. Throws `CredentialsError` when unsafe. */
export async function readSavedLogin(
  env: Readonly<Record<string, string | undefined>>,
): Promise<SavedLogin | undefined> {
  const path = credentialsPath(env);
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  if (!stats.isFile()) throw new CredentialsError('not_a_file', path);
  if ((stats.mode & 0o077) !== 0) throw new CredentialsError('unsafe_mode', path);
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) throw new CredentialsError('not_owner', path);
  if (stats.size > MAX_FILE_BYTES) throw new CredentialsError('malformed', path);
  let parsed;
  try {
    parsed = fileSchema.parse(JSON.parse(await readFile(path, 'utf8')));
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
  await chmod(dir, DIR_MODE);
  const path = join(dir, 'credentials.json');
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

/** Deletes the saved login. Returns false when there was none. */
export async function deleteSavedLogin(
  env: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  try {
    await unlink(credentialsPath(env));
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}
