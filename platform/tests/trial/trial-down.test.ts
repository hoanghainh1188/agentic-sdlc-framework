// Review of V02 (PR #236), the LOW findings: `trial:down --wipe` deletes only what belongs to the
// trial (its own Compose project, env file, TLS folder, and credentials files that still hold a
// login to the trial's API); `trial:up` refuses when Docker cannot list its volumes; the live
// test's project override never reaches the dev stack; every secret of the env file is hidden.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { isTrialLogin, trialDown } from '../../deploy/trial/src/down.js';
import { envSecrets, trialApiUrl, TRIAL_PROJECT } from '../../deploy/trial/src/env-file.js';
import { projectOverride, trialEnvFile } from '../../deploy/trial/src/override.js';
import { preflight, type HostFacts } from '../../deploy/trial/src/preflight.js';
import { SecretBag } from '../../deploy/trial/src/secrets.js';
import { parseSettings } from '../../deploy/trial/src/settings.js';
import type { Exec } from '../../deploy/trial/src/up.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-trial-down-'));
  dirs.push(dir);
  return dir;
}

const API = 'http://127.0.0.1:8090';
const login = (url: string) => `${JSON.stringify({ version: 1, api_url: url, token: 'x' })}\n`;

function world() {
  const root = tmp();
  const deploy = path.join(root, 'platform/deploy');
  fs.mkdirSync(path.join(deploy, 'openbao-tls'), { recursive: true });
  fs.writeFileSync(path.join(deploy, 'openbao-tls/ca.pem'), 'ca');
  const envFile = path.join(deploy, '.env');
  fs.writeFileSync(envFile, `COMPOSE_PROJECT_NAME=${TRIAL_PROJECT}\n`);
  const other = path.join(deploy, 'other-file');
  fs.writeFileSync(other, 'keep me');
  const credA = path.join(root, 'a/sdlc/credentials.json');
  const credB = path.join(root, 'b/sdlc/credentials.json');
  for (const f of [credA, credB]) fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(credA, login(`${API}/`));
  fs.writeFileSync(credB, login('https://sdlc.other-company.example'));
  const calls: string[][] = [];
  const exec: Exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    return Promise.resolve({ status: 0, stdout: '', stderr: '' });
  };
  return { root, deploy, envFile, other, credA, credB, calls, exec };
}

describe('trial:down', () => {
  it('stops only the trial project and deletes nothing without --wipe', async () => {
    const w = world();
    const r = await trialDown({
      repoRoot: w.root,
      envFile: w.envFile,
      project: TRIAL_PROJECT,
      wipe: false,
      credentialsFiles: [w.credA, w.credB],
      apiUrl: API,
      exec: w.exec,
    });
    expect(r.status).toBe(0);
    const args = w.calls[0]!;
    expect(args.slice(0, 4)).toEqual(['docker', 'compose', '-p', TRIAL_PROJECT]);
    expect(args).not.toContain('--volumes');
    for (const f of [w.envFile, w.credA, w.credB, path.join(w.deploy, 'openbao-tls/ca.pem')]) {
      expect(fs.existsSync(f)).toBe(true);
    }
  });

  it('--wipe removes the volumes, the env file, the TLS folder and the trial logins only', async () => {
    const w = world();
    const r = await trialDown({
      repoRoot: w.root,
      envFile: w.envFile,
      project: TRIAL_PROJECT,
      wipe: true,
      credentialsFiles: [w.credA, w.credB, path.join(w.root, 'missing.json')],
      apiUrl: API,
      exec: w.exec,
    });
    expect(r.status).toBe(0);
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]!.slice(0, 4)).toEqual(['docker', 'compose', '-p', TRIAL_PROJECT]);
    expect(w.calls[0]).toContain('--volumes');
    expect(fs.existsSync(w.envFile)).toBe(false);
    expect(fs.existsSync(path.join(w.deploy, 'openbao-tls'))).toBe(false);
    expect(fs.existsSync(w.credA)).toBe(false);
    // A login to another platform, saved at the same path later, is kept and reported.
    expect(fs.existsSync(w.credB)).toBe(true);
    expect(r.keptLogins).toEqual([w.credB]);
    expect(fs.readFileSync(w.other, 'utf8')).toBe('keep me');
  });

  it('deletes nothing when Compose fails', async () => {
    const w = world();
    const failing: Exec = () => Promise.resolve({ status: 1, stdout: '', stderr: 'boom' });
    const r = await trialDown({
      repoRoot: w.root,
      envFile: w.envFile,
      project: TRIAL_PROJECT,
      wipe: true,
      credentialsFiles: [w.credA],
      apiUrl: API,
      exec: failing,
    });
    expect(r.status).toBe(1);
    expect(fs.existsSync(w.envFile)).toBe(true);
    expect(fs.existsSync(w.credA)).toBe(true);
  });

  it('isTrialLogin compares the API address only, and refuses anything unreadable', () => {
    expect(isTrialLogin(login(API), API)).toBe(true);
    expect(isTrialLogin(login(`${API}/`), API)).toBe(true);
    expect(isTrialLogin(login('http://127.0.0.1:8091'), API)).toBe(false);
    expect(isTrialLogin('not json', API)).toBe(false);
    expect(isTrialLogin('{}', API)).toBe(false);
  });

  it('trialApiUrl reads the API host port of the env file', () => {
    expect(trialApiUrl('SDLC_API_HOST_PORT=28090\n')).toBe('http://127.0.0.1:28090');
    expect(trialApiUrl('')).toBe(API);
  });
});

describe('the live test override never reaches the dev stack', () => {
  const DEFAULT = '/repo/platform/deploy/.env';
  const env = (over: Record<string, string>) => ({
    SDLC_TRIAL_PROJECT: 'sdlctrialit-1',
    SDLC_TRIAL_ENV_FILE: '/tmp/x/.env',
    ...over,
  });

  it('is honoured with its own env file and a trial-like project name', () => {
    expect(projectOverride(env({}), DEFAULT)?.project).toBe('sdlctrialit-1');
    expect(trialEnvFile(env({}), DEFAULT)).toBe('/tmp/x/.env');
  });

  it('is ignored for the default env file, another project name, or a missing value', () => {
    for (const bad of [
      env({ SDLC_TRIAL_ENV_FILE: DEFAULT }),
      env({ SDLC_TRIAL_ENV_FILE: '/repo/platform/deploy/../deploy/.env' }),
      env({ SDLC_TRIAL_PROJECT: 'sdlc' }),
      env({ SDLC_TRIAL_PROJECT: 'my-stack' }),
      env({ SDLC_TRIAL_PROJECT: 'sdlc-trial_x' }),
      { SDLC_TRIAL_PROJECT: 'sdlctrialit-1' },
      { SDLC_TRIAL_ENV_FILE: '/tmp/x/.env' },
    ]) {
      expect(projectOverride(bad, DEFAULT)).toBeUndefined();
      expect(trialEnvFile(bad, DEFAULT)).toBe(DEFAULT);
    }
  });
});

describe('trial:up refuses when Docker cannot list its volumes', () => {
  const settings = parseSettings(
    `
fork: { repo: tester/pilot-order-inventory, clone: /src/pilot }
github_app: { client_id: Iv23liTEST01, private_key_file: /secure/app.pem }
model: { provider: anthropic, api_key_file: /secure/anthropic.key }
people:
  person_a: { email: a@example.test, name: A, github_id: 1001, github_login: tester-a, config_home: /h/a }
  person_b: { email: b@example.test, name: B, github_id: 1002, github_login: tester-b, config_home: /h/b }
`,
    '/home/tester',
  );
  const facts = (over: Partial<HostFacts>): HostFacts => ({
    nodeEnv: undefined,
    envFile: '/repo/platform/deploy/.env',
    envFileExists: false,
    existingVolumes: [],
    docker: { composeVersion: '2.39.1', memoryBytes: 12 * 1024 ** 3 },
    hostMemoryBytes: 32 * 1024 ** 3,
    ollamaTags: undefined,
    secretFiles: [
      { path: '/secure/app.pem', mode: 0o100600 },
      { path: '/secure/anthropic.key', mode: 0o100600 },
    ],
    forkInstructions: true,
    existingCredentials: [],
    ...over,
  });

  it('unknown volumes are a refusal, never "none"', () => {
    const keys = preflight(settings, facts({ existingVolumes: null })).map((r) => r.key);
    expect(keys).toContain('trial.refused.volumes_unknown');
    expect(preflight(settings, facts({})).map((r) => r.key)).not.toContain(
      'trial.refused.volumes_unknown',
    );
  });
});

describe('every secret of the env file is hidden', () => {
  it('envSecrets picks passwords, keys, tokens and salts', () => {
    const text = [
      'COMPOSE_PROJECT_NAME=sdlc-trial',
      'POSTGRES_PASSWORD=pg-secret-value-123',
      'LANGFUSE_SALT=salt-value-123456',
      'CLICKHOUSE_PASSWORD=short',
      'SDLC_API_HOST_PORT=8090',
      'LITELLM_MASTER_KEY=',
    ].join('\n');
    expect(envSecrets(text)).toEqual(['pg-secret-value-123', 'salt-value-123456']);
    const bag = new SecretBag();
    for (const value of envSecrets(text)) bag.keep(value);
    expect(bag.redact('compose: password pg-secret-value-123 refused')).not.toContain(
      'pg-secret-value-123',
    );
  });
});
