// D-08 V02: the pure parts of `pnpm trial:up` / `trial:down`: the settings file, the refusals
// (AC2), the redaction of secrets (AC3), the env file of the trial's own Compose project, the
// trial configuration (M-E-TRIAL-PLAN §6) and the `--wipe` guard (AC4).
import { t } from '@sdlc/messages';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { downRefusal } from '../../deploy/trial/src/down.js';
import { envValue, trialEnv, TRIAL_PROJECT } from '../../deploy/trial/src/env-file.js';
import { preflight, type HostFacts } from '../../deploy/trial/src/preflight.js';
import { parseInitOutput, SecretBag } from '../../deploy/trial/src/secrets.js';
import {
  credentialsFile,
  parseSettings,
  SettingsError,
  type TrialSettings,
} from '../../deploy/trial/src/settings.js';
import { trialProjectConfig } from '../../deploy/trial/src/trial-config.js';

const HOME = '/home/tester';
const GIB = 1024 ** 3;

const SETTINGS_YAML = `
fork:
  repo: tester/pilot-order-inventory
  clone: ~/src/pilot
github_app:
  client_id: Iv23liTEST01
  private_key_file: ~/secrets/app.pem
model:
  provider: anthropic
  api_key_file: /secure/anthropic.key
people:
  person_a: { email: a@example.test, name: Person A, github_id: 1001, github_login: tester-a, config_home: ~/.config }
  person_b: { email: b@example.test, name: Person B, github_id: "1002", github_login: tester-b, config_home: ~/.config/b }
`;

function settings(yaml = SETTINGS_YAML): TrialSettings {
  return parseSettings(yaml, HOME);
}

function fieldOf(yaml: string): string {
  try {
    parseSettings(yaml, HOME);
  } catch (error) {
    if (error instanceof SettingsError) return error.field;
    throw error;
  }
  return '(none)';
}

function facts(over: Partial<HostFacts> = {}): HostFacts {
  return {
    nodeEnv: undefined,
    envFile: '/repo/platform/deploy/.env',
    envFileExists: false,
    existingVolumes: [],
    docker: { composeVersion: '2.39.1', memoryBytes: 12 * GIB },
    hostMemoryBytes: 32 * GIB,
    ollamaTags: undefined,
    secretFiles: [{ path: '/secure/app.pem', mode: 0o100600 }],
    forkInstructions: true,
    existingCredentials: [],
    ...over,
  };
}

describe('V02 AC1: the settings file', () => {
  it('reads every field, expands ~/ and fills the defaults', () => {
    const s = settings();
    expect(s).toMatchObject({
      tenant: 'trial',
      project: 'pilot',
      forkRepo: 'tester/pilot-order-inventory',
      forkClone: '/home/tester/src/pilot',
      appKeyFile: '/home/tester/secrets/app.pem',
      model: { provider: 'anthropic', apiKeyFile: '/secure/anthropic.key' },
    });
    // A numeric ID written without quotes is read as its digits (QUESTIONS #45).
    expect(s.personA.githubId).toBe('1001');
    expect(s.personB.githubId).toBe('1002');
    expect(credentialsFile(s.personB)).toBe('/home/tester/.config/b/sdlc/credentials.json');
  });

  it('defaults the Ollama address to Docker Desktop host name', () => {
    const s = settings(
      SETTINGS_YAML.replace(/provider: anthropic\n {2}api_key_file: \S+/, 'provider: ollama'),
    );
    expect(s.model).toEqual({ provider: 'ollama', ollamaUrl: 'http://host.docker.internal:11434' });
  });

  it('names the first bad field, never its value', () => {
    expect(fieldOf('not: [valid')).toBe('(file)');
    expect(fieldOf(SETTINGS_YAML.replace('tester/pilot-order-inventory', 'no-slash'))).toBe(
      'fork.repo',
    );
    expect(fieldOf(SETTINGS_YAML.replace('~/src/pilot', 'relative/path'))).toBe('fork.clone');
    expect(fieldOf(SETTINGS_YAML.replace('provider: anthropic', 'provider: openai'))).toBe(
      'model.provider',
    );
    expect(fieldOf(SETTINGS_YAML.replace('github_id: 1001', 'github_id: tester-a'))).toBe(
      'people.person_a.github_id',
    );
  });

  it('refuses option-like values and control characters', () => {
    expect(fieldOf(SETTINGS_YAML.replace('name: Person A', 'name: --help'))).toBe(
      'people.person_a.name',
    );
    expect(fieldOf(SETTINGS_YAML.replace('a@example.test', '-x@example.test'))).toBe(
      'people.person_a.email',
    );
    expect(fieldOf(SETTINGS_YAML.replace('name: Person A', 'name: "A\\u0007"'))).toBe(
      'people.person_a.name',
    );
  });

  it('refuses one person in both roles (QUESTIONS #341)', () => {
    expect(fieldOf(SETTINGS_YAML.replace('github_id: "1002"', 'github_id: "1001"'))).toBe(
      'people.person_b.github_id',
    );
    expect(fieldOf(SETTINGS_YAML.replace('b@example.test', 'A@example.test'))).toBe(
      'people.person_b.email',
    );
    expect(fieldOf(SETTINGS_YAML.replace('~/.config/b', '~/.config'))).toBe(
      'people.person_b.config_home',
    );
  });

  it('the example file in the repository is valid', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { repoRoot } = await import('../workspace/helpers.js');
    const text = fs.readFileSync(
      path.join(repoRoot(), 'platform/deploy/trial/trial-settings.example.yaml'),
      'utf8',
    );
    expect(settings(text).model.provider).toBe('ollama');
  });
});

describe('V02 AC2: refusals before anything is touched', () => {
  it('a clean machine passes', () => {
    expect(preflight(settings(), facts())).toEqual([]);
  });

  it.each([
    ['production', { nodeEnv: 'production' }, 'trial.refused.production'],
    ['an existing env file', { envFileExists: true }, 'trial.refused.env_exists'],
    [
      'dev stack volumes',
      { existingVolumes: ['sdlc_postgres-data'] },
      'trial.refused.volumes_exist',
    ],
    ['no Docker', { docker: null }, 'trial.refused.no_docker'],
    [
      'an old Compose',
      { docker: { composeVersion: '2.20.3', memoryBytes: 12 * GIB } },
      'trial.refused.compose_old',
    ],
    [
      'little Docker memory',
      { docker: { composeVersion: 'v2.39.1', memoryBytes: 4 * GIB } },
      'trial.refused.docker_memory',
    ],
    ['little host memory', { hostMemoryBytes: 8 * GIB }, 'trial.refused.host_memory'],
    [
      'a readable key file',
      { secretFiles: [{ path: '/k', mode: 0o100644 }] },
      'trial.refused.file_mode',
    ],
    [
      'a missing key file',
      { secretFiles: [{ path: '/k', mode: null }] },
      'trial.refused.file_missing',
    ],
    ['no AGENTS.md on main', { forkInstructions: false }, 'trial.refused.fork_instructions'],
    [
      'a saved login',
      { existingCredentials: ['/c/sdlc/credentials.json'] },
      'trial.refused.credentials_exist',
    ],
  ] as const)('refuses %s', (_name, over, key) => {
    const keys = preflight(settings(), facts(over)).map((r) => r.key);
    expect(keys).toEqual([key]);
  });

  it('the local model needs Ollama, the tag, and 32 GB', () => {
    const local = settings(
      SETTINGS_YAML.replace(/provider: anthropic\n {2}api_key_file: \S+/, 'provider: ollama'),
    );
    expect(preflight(local, facts({ ollamaTags: null })).map((r) => r.key)).toEqual([
      'trial.refused.ollama_unreachable',
    ]);
    expect(preflight(local, facts({ ollamaTags: ['llama3:8b'] })).map((r) => r.key)).toEqual([
      'trial.refused.ollama_model_missing',
    ]);
    expect(
      preflight(local, facts({ ollamaTags: ['gpt-oss:20b'], hostMemoryBytes: 24 * GIB })).map(
        (r) => r.key,
      ),
    ).toEqual(['trial.refused.host_memory']);
    expect(preflight(local, facts({ ollamaTags: ['gpt-oss:20b'] }))).toEqual([]);
  });

  it('every refusal renders from the catalog with all its values', () => {
    const all = preflight(
      settings(),
      facts({
        nodeEnv: 'production',
        envFileExists: true,
        existingVolumes: ['sdlc_x'],
        docker: { composeVersion: '2.1.0', memoryBytes: GIB },
        hostMemoryBytes: GIB,
        secretFiles: [{ path: '/k', mode: 0o100666 }],
        forkInstructions: false,
        existingCredentials: ['/c'],
      }),
    );
    expect(all.length).toBe(9);
    for (const r of all) expect(t(r.key, r.params)).not.toMatch(/\{[a-z_]+\}/);
  });
});

describe('V02 AC3: secrets never reach the terminal', () => {
  it('hides kept values and anything that looks like a secret', () => {
    const bag = new SecretBag();
    bag.keep('correct-horse-battery-staple');
    const text = [
      'password correct-horse-battery-staple in a log line',
      'Unseal Key 1: abcdefghijklmnopqrstuvwxyz0123456789',
      'Initial Root Token: s.AAAAAAAAAAAAAAAAAAAAAAAA',
      `token ${'sdlc_pat_'}${'x'.repeat(43)}`,
      `vault ${'hvs'}.${'CAESI'}${'q'.repeat(24)}`,
      // Built at run time, so no PEM header is in the source (Gitleaks rule private-key).
      `-----BEGIN RSA ${'PRIVATE'} KEY-----\nMIIE\n-----END RSA ${'PRIVATE'} KEY-----`,
    ].join('\n');
    const out = bag.redact(text);
    expect(out).not.toMatch(/correct-horse|abcdefghijklmnop|AAAAAAAA|xxxxxxxx|CAESI|qqqq|MIIE/);
    expect(out).toContain('Unseal Key 1: <redacted>');
  });

  it('hides one line of a multi-line secret, and the URL-encoded form', () => {
    const bag = new SecretBag();
    bag.keep('-----BEGIN KEY-----\nMIIEpAIBAAKCAQEAsecretline0123\n-----END KEY-----');
    bag.keep('p@ss/word+with=chars');
    expect(bag.redact('error near MIIEpAIBAAKCAQEAsecretline0123')).not.toContain('secretline');
    expect(bag.redact('postgres://u:p%40ss%2Fword%2Bwith%3Dchars@h')).not.toContain('p%40ss');
  });

  it('a dropped value is no longer needed, the patterns still apply', () => {
    const bag = new SecretBag();
    bag.keep('some-throwaway-share');
    bag.drop('some-throwaway-share');
    expect(bag.size).toBe(0);
    expect(bag.redact('Unseal Key 2: some-throwaway-share')).toBe('Unseal Key 2: <redacted>');
  });

  it('reads the shares and the root token of the init output', () => {
    const out =
      'Unseal Key 1: one111\nUnseal Key 2: two222\nUnseal Key 3: three3\n\nInitial Root Token: s.root\n';
    expect(parseInitOutput(out)).toEqual({
      shares: ['one111', 'two222', 'three3'],
      rootToken: 's.root',
    });
    expect(() => parseInitOutput('nothing')).toThrow();
  });
});

describe('V02: the env file and the configuration of the trial stack', () => {
  const example =
    'COMPOSE_PROJECT_NAME=sdlc\nSDLC_NETWORK_SUBNET=172.30.0.0/24\nSDLC_NETWORK_GATEWAY=172.30.0.1\nSDLC_API_HOST_PORT=8090\nLITELLM_MASTER_KEY=sk-abc\nLITELLM_SALT_KEY=def\n';

  it('uses its own Compose project and takes the gateway keys from OpenBao', () => {
    const out = trialEnv(example);
    expect(envValue(out, 'COMPOSE_PROJECT_NAME')).toBe(TRIAL_PROJECT);
    expect(TRIAL_PROJECT.startsWith('sdlc_')).toBe(false);
    expect(envValue(out, 'LITELLM_MASTER_KEY')).toBe('');
    expect(envValue(out, 'LITELLM_SALT_KEY')).toBe('');
    expect(envValue(out, 'SDLC_API_HOST_PORT')).toBe('8090');
  });

  it('the live test moves the ports and the network', () => {
    const out = trialEnv(example, {
      project: 'x1',
      subnet: '172.29.1.0/24',
      gateway: '172.29.1.1',
      portOffset: 33000,
    });
    expect(envValue(out, 'SDLC_API_HOST_PORT')).toBe('41090');
    expect(envValue(out, 'SDLC_NETWORK_SUBNET')).toBe('172.29.1.0/24');
  });

  it('the trial configuration of M-E-TRIAL-PLAN §6', () => {
    const image = `localhost:5050/sdlc/node24@sha256:${'a'.repeat(64)}`;
    expect(parse(trialProjectConfig(image))).toEqual({
      oversight: { hotl_block_window: { value: 1, unit: 'working_hours' } },
      verification: { required_checks: ['ci-ok'] },
      run: { agent_key: 'trial-coder' },
      sandbox: { image },
    });
    expect(() => trialProjectConfig('node24:latest')).toThrow();
    expect(() => trialProjectConfig(`x\nrun: {}\n@sha256:${'a'.repeat(64)}`)).toThrow();
  });
});

describe('V02 AC4: trial:down acts on the trial stack only', () => {
  it('refuses another Compose project, and a missing env file', () => {
    expect(downRefusal(undefined, TRIAL_PROJECT)).toBe('no_env');
    expect(downRefusal('COMPOSE_PROJECT_NAME=sdlc\n', TRIAL_PROJECT)).toBe('not_trial');
    expect(downRefusal(`COMPOSE_PROJECT_NAME=${TRIAL_PROJECT}\n`, TRIAL_PROJECT)).toBeUndefined();
  });
});
