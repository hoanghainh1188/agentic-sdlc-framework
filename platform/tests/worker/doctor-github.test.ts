// The worker's GitHub check for `pnpm doctor` (D-08 V07, QUESTIONS #400): `inspectInstallation`
// reads the App and each installation with the App JWT only (no token minted), and
// `doctorGitHub` turns the result or a failure into codes; no key, JWT or text in the answer.
import { inspectInstallation } from '@sdlc/adapter-git-github';
import { GitHostError } from '@sdlc/contracts';
import { SecretsError } from '@sdlc/secrets';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { doctorGitHub, failureCode } from '../../apps/worker/src/doctor-github.js';
import { SettingsError } from '../../apps/worker/src/settings.js';
import { APP_PRIVATE_KEY_PEM, FakeSecrets, StubGitHub } from '../git-github/stub-github';

describe('inspectInstallation (GitHub only)', () => {
  let stub: StubGitHub;
  beforeEach(async () => {
    stub = new StubGitHub();
    await stub.start();
  });
  afterEach(() => stub.stop());

  const options = () => ({
    secrets: new FakeSecrets(),
    apiUrl: stub.address,
    allowPlaintext: true,
    now: () => stub.now,
  });

  it('reads the App and each installation with GET and the App JWT, and mints no token', async () => {
    stub.on('GET', '/app', {
      body: { id: 1, permissions: { contents: 'write', metadata: 'read', 'Odd Name': 'x' } },
    });
    stub.on('GET', '/repos/acme/shop/installation', {
      body: {
        id: 7,
        repository_selection: 'selected',
        permissions: { contents: 'write', issues: 'superpower' },
      },
    });
    stub.on('GET', '/repos/acme/gone/installation', {
      status: 404,
      body: { message: 'Not Found' },
    });
    const report = await inspectInstallation(options(), [
      { owner: 'acme', name: 'shop' },
      { owner: 'acme', name: 'gone' },
    ]);
    expect(report).toEqual({
      app: { permissions: { contents: 'write', metadata: 'read' } },
      repos: [
        {
          repo: 'acme/shop',
          installed: true,
          selection: 'selected',
          permissions: { contents: 'write' },
        },
        { repo: 'acme/gone', installed: false },
      ],
    });
    expect(stub.requests.every((r) => r.method === 'GET')).toBe(true);
    expect(stub.issuedTokens).toEqual([]);
    expect(JSON.stringify(report)).not.toContain(APP_PRIVATE_KEY_PEM.slice(40, 80));
  });
});

describe('doctorGitHub', () => {
  it('sorts and de-duplicates the repositories, and skips a malformed name', async () => {
    const asked: string[] = [];
    const out = await doctorGitHub({
      listRepos: () => Promise.resolve(['acme/b', 'acme/a', 'acme/b', 'not-a-repo']),
      inspect: (repos) => {
        asked.push(...repos.map((r) => `${r.owner}/${r.name}`));
        return Promise.resolve({ app: { permissions: {} }, repos: [] });
      },
    });
    expect(asked).toEqual(['acme/a', 'acme/b']);
    expect(out).toEqual({ ok: true, app: { permissions: {} }, repos: [] });
  });

  it('a failure becomes a code, never its text', async () => {
    const out = await doctorGitHub({
      listRepos: () => Promise.resolve(['acme/a']),
      inspect: () => Promise.reject(new GitHostError('app_not_installed', { repo: 'acme/a' })),
    });
    expect(out).toEqual({ ok: false, error: 'git_host_app_not_installed' });
  });

  it.each([
    [
      new SecretsError('secrets.openbao.sealed', { address: 'https://openbao:8200' }),
      'openbao_sealed',
    ],
    [
      new SecretsError('secrets.login_failed', { status: 400, file: '/run/x' }),
      'openbao_login_failed',
    ],
    [new SecretsError('secrets.not_found', { path: 'shared/github-app' }), 'openbao'],
    [new SettingsError('worker.settings.invalid', 'X'), 'settings'],
    [new Error('anything'), 'unexpected'],
  ])('failureCode(%s) is %s', (error, code) => {
    expect(failureCode(error)).toBe(code);
  });
});
