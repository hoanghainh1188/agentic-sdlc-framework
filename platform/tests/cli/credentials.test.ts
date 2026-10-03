// The saved login of `sdlc login` (B04, design/ADR-M36 §2.1): file modes, refusal of unsafe files,
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
  readSavedLogin,
  writeSavedLogin,
} from '../../apps/cli/src/credentials/store.js';
import { API_URL, TOKEN } from './harness.js';

let home: string;
let env: Record<string, string>;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'sdlc-cred-'));
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
  it('uses ~/.config/sdlc, or $XDG_CONFIG_HOME/sdlc when it is absolute', () => {
    expect(credentialsDir({ HOME: '/home/a' })).toBe('/home/a/.config/sdlc');
    expect(credentialsDir({ HOME: '/home/a', XDG_CONFIG_HOME: '/x' })).toBe('/x/sdlc');
    expect(credentialsDir({ HOME: '/home/a', XDG_CONFIG_HOME: 'relative' })).toBe(
      '/home/a/.config/sdlc',
    );
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
