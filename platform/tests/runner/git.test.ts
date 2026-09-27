// D-08 C04 AC2, ADR-M25 §2.1 and §2.11: the runner clones with the run's short-lived token and
// creates `agent/INT-…` at `base_sha`. The token travels only as an HTTP header, never in the URL
// or `.git/config`; a wrong token or an unknown commit fails with a code, never with git's text.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Redacted } from '@sdlc/secrets';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  authEnv,
  CloneError,
  cloneForRun,
  packDirectory,
  cloneUrl,
  runnerSettingsFromEnv,
  type GitSettings,
} from '../../apps/runner/src/index.js';
import { StubGitHost } from './stub-git';

const TOKEN = 'ghs_c04CloneTokenCanary000000000000000';

/** Every file under `dir` whose content contains `needle`. */
function filesContaining(dir: string, needle: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) => fs.readFileSync(file).includes(needle));
}
const REPO = 'org/pilot-order-inventory';
const BRANCH = 'agent/INT-2026-0001';

describe('cloneForRun (stub Git host)', () => {
  let host: StubGitHost;
  let settings: GitSettings;
  let first: string;
  let second: string;
  let dir: string;

  beforeAll(async () => {
    host = await StubGitHost.start(TOKEN);
    ({ first, second } = host.createRepo(REPO, { 'README.md': 'pilot\n' }));
    settings = runnerSettingsFromEnv({
      SDLC_RUNNER_GIT_BASE_URL: host.origin,
      SDLC_RUNNER_GIT_ALLOW_PLAINTEXT: '1',
    }).git;
  });
  afterAll(() => host.stop());
  afterEach(() => {
    host.token = TOKEN;
    host.requests.length = 0;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const clone = (overrides: { baseSha?: string; token?: string; repo?: string } = {}) => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-clone-'));
    return cloneForRun(settings, {
      repo: overrides.repo ?? REPO,
      baseSha: overrides.baseSha ?? first,
      branch: BRANCH,
      token: new Redacted(overrides.token ?? TOKEN),
      dir,
    });
  };

  it('clones and creates the agent branch at base_sha, not at the latest commit', async () => {
    const repoDir = await clone();
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8' }).trim();
    expect(git('rev-parse', 'HEAD')).toBe(first);
    expect(git('rev-parse', '--abbrev-ref', 'HEAD')).toBe(BRANCH);
    expect(git('rev-parse', 'origin/main')).toBe(second);
    expect(fs.readFileSync(path.join(repoDir, 'README.md'), 'utf8')).toBe('pilot\n');
    expect(fs.existsSync(path.join(repoDir, 'CHANGELOG.md'))).toBe(false);
  });

  it('sends the token as a header only: never in a URL or in .git', async () => {
    const repoDir = await clone();
    expect(host.requests.length).toBeGreaterThan(0);
    expect(host.requests.every((r) => r.authorized)).toBe(true);
    expect(host.requests.some((r) => r.url.includes(TOKEN))).toBe(false);
    const config = fs.readFileSync(path.join(repoDir, '.git', 'config'), 'utf8');
    expect(config).not.toContain(TOKEN);
    expect(config).toContain(`url = ${host.origin}/${REPO}.git`);
    expect(filesContaining(repoDir, TOKEN)).toEqual([]);
  });

  it('a cloned repository with links out of the clone packs as link entries only', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-outside-'));
    const secret = path.join(outside, 'secret.txt');
    const canary = 'outside-canary-in-git-test';
    fs.writeFileSync(secret, canary);
    try {
      const repo = 'org/links';
      const { first } = host.createRepo(
        repo,
        { 'README.md': 'links\n' },
        { symlinks: { 'absolute-link': secret, 'dotdot-link': '../../../../../etc/passwd' } },
      );
      const repoDir = await clone({ repo, baseSha: first });
      expect(fs.readlinkSync(path.join(repoDir, 'absolute-link'))).toBe(secret);
      const archive = packDirectory(repoDir, 64 * 1024 * 1024);
      expect(archive.includes(Buffer.from(canary))).toBe(false);
      expect(archive.includes(Buffer.from(secret))).toBe(true); // the link target path only
      expect(archive.includes(Buffer.from('../../../../../etc/passwd'))).toBe(true);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('fails with clone_failed for a wrong token, without git text', async () => {
    host.token = 'another-token';
    const error = await clone().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloneError);
    expect((error as CloneError).reason).toBe('clone_failed');
    expect(String(error)).not.toContain(TOKEN);
    expect(String(error)).not.toMatch(/fatal|Authentication/);
  });

  it('fails with base_sha_not_found for a commit that is not in the repository', async () => {
    await expect(clone({ baseSha: 'f'.repeat(40) })).rejects.toMatchObject({
      reason: 'base_sha_not_found',
    });
  });

  it.each([['../evil'], ['org/../../etc'], ['-x/y'], ['org']])(
    'refuses the repository name %s before running git',
    async (repo) => {
      await expect(clone({ repo })).rejects.toMatchObject({ reason: 'clone_failed' });
      expect(host.requests).toEqual([]);
    },
  );

  it('scopes the header to the Git host origin and builds a URL without credentials', () => {
    const env = authEnv(settings, new Redacted(TOKEN));
    expect(env.GIT_CONFIG_KEY_0).toBe(`http.${host.origin}/.extraheader`);
    expect(env.GIT_CONFIG_VALUE_0).toBe(
      `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`,
    );
    expect(cloneUrl(settings, REPO)).toBe(`${host.origin}/${REPO}.git`);
  });
});

describe('Git settings', () => {
  it('default to https://github.com; http only with SDLC_RUNNER_GIT_ALLOW_PLAINTEXT=1', () => {
    expect(runnerSettingsFromEnv({}).git.baseUrl.origin).toBe('https://github.com');
    expect(() => runnerSettingsFromEnv({ SDLC_RUNNER_GIT_BASE_URL: 'http://127.0.0.1:9' })).toThrow(
      'SDLC_RUNNER_GIT_BASE_URL',
    );
    for (const bad of ['https://user:pw@github.com', 'https://github.com/org', 'file:///repo']) {
      expect(() => runnerSettingsFromEnv({ SDLC_RUNNER_GIT_BASE_URL: bad })).toThrow(
        'SDLC_RUNNER_GIT_BASE_URL',
      );
    }
  });
});
