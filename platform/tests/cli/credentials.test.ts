// The saved login of `adlc login` (B04, design/ADR-M36 §2.1): file modes, refusal of unsafe files,
// atomic replacement, and the API address rules (§2.3).
import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isApiToken, normaliseApiUrl } from '../../apps/cli/src/credentials/settings.js';
import {
  CredentialsError,
  credentialsDir,
  credentialsPath,
  deleteSavedLogin,
  legacyCredentialsDir,
  readSavedLogin,
  writeSavedLogin,
} from '../../apps/cli/src/credentials/store.js';
import { API_URL, TOKEN } from './harness.js';

let home: string;
let env: Record<string, string>;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'adlc-cred-'));
  env = { HOME: home };
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const login = { apiUrl: API_URL, token: TOKEN };

async function expectProblem(problem: string): Promise<void> {
  await expect(readSavedLogin(env)).rejects.toSatisfy(
    (error) => error instanceof CredentialsError && error.problem === problem,
  );
}

describe('saved login (ADR-M36 §2.1)', () => {
  it('uses ~/.config/adlc, or $XDG_CONFIG_HOME/adlc when it is absolute', () => {
    expect(credentialsDir({ HOME: '/home/a' })).toBe('/home/a/.config/adlc');
    expect(credentialsDir({ HOME: '/home/a', XDG_CONFIG_HOME: '/x' })).toBe('/x/adlc');
    expect(credentialsDir({ HOME: '/home/a', XDG_CONFIG_HOME: 'relative' })).toBe(
      '/home/a/.config/adlc',
    );
    expect(legacyCredentialsDir({ HOME: '/home/a' })).toBe('/home/a/.config/sdlc');
    expect(legacyCredentialsDir({ HOME: '/home/a', XDG_CONFIG_HOME: '/x' })).toBe('/x/sdlc');
    expect(() => credentialsDir({})).toThrow(CredentialsError);
    expect(() => credentialsDir({ HOME: 'relative' })).toThrow(CredentialsError);
  });

  it('writes the folder with mode 700 and the file with mode 600, and reads it back', async () => {
    const path = await writeSavedLogin(env, login);
    expect(path).toBe(credentialsPath(env));
    expect((await stat(credentialsDir(env))).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readSavedLogin(env)).toEqual(login);
  });

  it('tightens an existing folder to 700 and leaves no temporary file', async () => {
    await writeSavedLogin(env, login);
    await chmod(credentialsDir(env), 0o755);
    await writeSavedLogin(env, { ...login, apiUrl: 'https://other.example.test' });
    expect((await stat(credentialsDir(env))).mode & 0o777).toBe(0o700);
    expect(await readdir(credentialsDir(env))).toEqual(['credentials.json']);
    expect((await readSavedLogin(env))?.apiUrl).toBe('https://other.example.test');
  });

  it('returns undefined when there is no saved login', async () => {
    expect(await readSavedLogin(env)).toBeUndefined();
  });

  it.each([0o640, 0o604, 0o644])('refuses a file with mode %o', async (mode) => {
    const path = await writeSavedLogin(env, login);
    await chmod(path, mode);
    await expectProblem('unsafe_mode');
  });

  it('refuses a symbolic link', async () => {
    const path = await writeSavedLogin(env, login);
    const target = join(home, 'elsewhere.json');
    await writeFile(target, '{}', { mode: 0o600 });
    await rm(path);
    await symlink(target, path);
    await expectProblem('not_a_file');
  });

  it.each([
    'not json',
    JSON.stringify({ version: 2, api_url: API_URL, token: TOKEN }),
    JSON.stringify({ version: 1, api_url: 'http://remote.example.test', token: TOKEN }),
    JSON.stringify({ version: 1, api_url: API_URL, token: 'sdlc_pat_short' }),
    JSON.stringify({ version: 1, api_url: API_URL, token: TOKEN, extra: 1 }),
  ])('refuses malformed content %#', async (content) => {
    const path = await writeSavedLogin(env, login);
    await writeFile(path, content, { mode: 0o600 });
    await expectProblem('malformed');
  });

  it('refuses a folder that is a link to somewhere else', async () => {
    const elsewhere = join(home, 'elsewhere');
    await mkdir(elsewhere, { mode: 0o755 });
    await mkdir(join(home, '.config'));
    await symlink(elsewhere, credentialsDir(env));
    await expect(writeSavedLogin(env, login)).rejects.toSatisfy(
      (error) => error instanceof CredentialsError && error.problem === 'not_a_file',
    );
    expect(await readdir(elsewhere)).toEqual([]);
    expect((await stat(elsewhere)).mode & 0o777).toBe(0o755);
  });

  it('logout also removes temporary files a killed login left behind', async () => {
    await writeSavedLogin(env, login);
    const stale = join(credentialsDir(env), '.credentials.0123456789abcdef.tmp');
    await writeFile(stale, 'x', { mode: 0o600 });
    expect(await deleteSavedLogin(env)).toBe(true);
    expect(await readdir(credentialsDir(env))).toEqual([]);
  });

  it('deletes the saved login once', async () => {
    await writeSavedLogin(env, login);
    expect(await deleteSavedLogin(env)).toBe(true);
    expect(await deleteSavedLogin(env)).toBe(false);
    expect(await readSavedLogin(env)).toBeUndefined();
  });
});

/** A login saved by the old command `sdlc` (before v0.9.0): the same file in `<config>/sdlc/`. */
async function writeLegacyLogin(value: { apiUrl: string; token: string }, mode = 0o600) {
  const dir = legacyCredentialsDir(env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'credentials.json');
  const body = { version: 1, api_url: value.apiUrl, token: value.token };
  await writeFile(path, JSON.stringify(body), { mode });
  return path;
}

describe("the old command's login folder (ADR-M100 §2.3)", () => {
  it('reads the login of `sdlc` while the new folder has none, and never writes there', async () => {
    const path = await writeLegacyLogin(login);
    expect(await readSavedLogin(env)).toEqual(login);
    await writeSavedLogin(env, { ...login, apiUrl: 'https://other.example.test' });
    expect((await readSavedLogin(env))?.apiUrl).toBe('https://other.example.test');
    expect((await stat(path)).isFile()).toBe(true); // the old file is left as it was
  });

  it('prefers the new login when both exist', async () => {
    await writeLegacyLogin({ ...login, apiUrl: 'https://old.example.test' });
    await writeSavedLogin(env, login);
    expect(await readSavedLogin(env)).toEqual(login);
  });

  it('checks the old file like the new one: a file others can read is refused', async () => {
    const path = await writeLegacyLogin(login, 0o644);
    await expect(readSavedLogin(env)).rejects.toSatisfy(
      (e) => e instanceof CredentialsError && e.problem === 'unsafe_mode' && e.path === path,
    );
  });

  it('refuses a symbolic link in the old folder', async () => {
    const elsewhere = join(home, 'elsewhere.json');
    const body = { version: 1, api_url: login.apiUrl, token: login.token };
    await writeFile(elsewhere, JSON.stringify(body), { mode: 0o600 });
    await mkdir(legacyCredentialsDir(env), { recursive: true, mode: 0o700 });
    await symlink(elsewhere, join(legacyCredentialsDir(env), 'credentials.json'));
    await expect(readSavedLogin(env)).rejects.toSatisfy(
      (e) => e instanceof CredentialsError && e.problem === 'not_a_file',
    );
  });

  it('never puts the token in an error', async () => {
    await writeLegacyLogin({ apiUrl: 'not a url', token: login.token });
    const error = await readSavedLogin(env).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CredentialsError);
    expect(JSON.stringify(error)).not.toContain(login.token);
    expect(String((error as Error).message)).not.toContain(login.token);
  });

  it('a logout deletes the login in both folders, so the old one never comes back', async () => {
    await writeLegacyLogin(login);
    await writeSavedLogin(env, login);
    expect(await deleteSavedLogin(env)).toBe(true);
    expect(await readSavedLogin(env)).toBeUndefined();
    expect(await deleteSavedLogin(env)).toBe(false);
  });

  it('a logout with only the old login deletes it', async () => {
    await writeLegacyLogin(login);
    expect(await deleteSavedLogin(env)).toBe(true);
    expect(await readSavedLogin(env)).toBeUndefined();
  });
});

describe('API address and token rules (ADR-M36 §2.3)', () => {
  it.each([
    ['https://sdlc.example.test', 'https://sdlc.example.test'],
    ['https://sdlc.example.test/', 'https://sdlc.example.test'],
    ['https://sdlc.example.test/base/', 'https://sdlc.example.test/base'],
    ['http://127.0.0.1:8090', 'http://127.0.0.1:8090'],
    ['http://localhost:8090/', 'http://localhost:8090'],
    ['http://[::1]:8090', 'http://[::1]:8090'],
  ])('accepts %s', (value, expected) => {
    expect(normaliseApiUrl(value)).toEqual({ url: expected });
  });

  it.each([
    ['http://sdlc.example.test', 'insecure'],
    ['http://10.0.0.5:8090', 'insecure'],
    ['ftp://sdlc.example.test', 'invalid'],
    ['sdlc.example.test', 'invalid'],
    ['https://user:pw@sdlc.example.test', 'credentials'],
    ['https://sdlc.example.test/?x=1', 'query'],
    ['https://sdlc.example.test/#a', 'query'],
    ['https://sdlc.example.test/?', 'query'],
  ])('refuses %s (%s)', (value, problem) => {
    expect(normaliseApiUrl(value)).toEqual({ problem });
  });

  it('checks the token shape', () => {
    expect(isApiToken(TOKEN)).toBe(true);
    expect(isApiToken(`${TOKEN}x`)).toBe(false);
    expect(isApiToken(TOKEN.replace('sdlc_pat_', 'sdlc_pak_'))).toBe(false);
    expect(isApiToken(` ${TOKEN}`)).toBe(false);
  });
});
