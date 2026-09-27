// Runner settings (ADR-M25 §2.6): deployment values from the environment, checked strictly. They
// choose sizes and reachable services; they can never loosen the sandbox hardening.
import { describe, expect, it } from 'vitest';

import { RunnerError, runnerSettingsFromEnv } from '../../apps/runner/src/index.js';
import { settings } from './helpers';

const refused = (env: NodeJS.ProcessEnv) => () => runnerSettingsFromEnv(env);

describe('runner settings', () => {
  it('has safe defaults: one sandbox, 2 GiB, 1.5 CPUs, 512 processes, no egress', () => {
    const s = runnerSettingsFromEnv({});
    expect(s).toMatchObject({
      dockerSocket: '/var/run/docker.sock',
      instance: 'sdlc',
      maxSandboxes: 1,
      limits: {
        memoryBytes: 2048 * 1024 * 1024,
        nanoCpus: 1_500_000_000,
        pids: 512,
        tmpBytes: 512 * 1024 * 1024,
      },
      egressServices: [],
      npmRegistry: undefined,
      workspaceMaxBytes: 1024 * 1024 * 1024,
      readyTimeoutMs: 120_000,
    });
    expect(s.git).toMatchObject({ allowPlaintext: false, timeoutMs: 300_000 });
    expect(s.git.baseUrl.origin).toBe('https://github.com');
    expect(s.workDir).toMatch(/sdlc-runner$/);
  });

  it('reads the concurrent sandbox limit (D-08 C04 AC3: configurable)', () => {
    expect(settings({ SDLC_RUNNER_MAX_SANDBOXES: '2' }).maxSandboxes).toBe(2);
  });

  it('reads the egress services and the npm registry of the package proxy', () => {
    const s = settings();
    expect(s.egressServices).toEqual([
      { alias: 'litellm', container: 'sdlc-litellm-1', port: 4000 },
      { alias: 'npm-proxy', container: 'sdlc-npm-proxy-1', port: 4873 },
    ]);
    expect(s.npmRegistry).toBe('http://npm-proxy:4873/');
  });

  it.each([
    ['SDLC_RUNNER_MAX_SANDBOXES', '0'],
    ['SDLC_RUNNER_MAX_SANDBOXES', '17'],
    ['SDLC_RUNNER_MAX_SANDBOXES', '1.5'],
    ['SDLC_RUNNER_SANDBOX_MEMORY_MB', '64'],
    ['SDLC_RUNNER_SANDBOX_CPUS', '0'],
    ['SDLC_RUNNER_SANDBOX_CPUS', 'all'],
    ['SDLC_RUNNER_SANDBOX_PIDS', '-1'],
    ['SDLC_RUNNER_DOCKER_SOCKET', 'tcp://0.0.0.0:2375'],
    ['SDLC_RUNNER_INSTANCE', 'Bad Name'],
    ['SDLC_RUNNER_EGRESS_SERVICES', 'litellm=sdlc-litellm-1'],
    ['SDLC_RUNNER_EGRESS_SERVICES', 'github.com=github.com:443'],
    ['SDLC_RUNNER_EGRESS_SERVICES', 'litellm=a:4000,litellm=b:4000'],
    ['SDLC_RUNNER_WORK_DIR', 'relative/dir'],
    ['SDLC_RUNNER_WORKSPACE_MAX_MB', '0'],
    ['SDLC_RUNNER_READY_TIMEOUT_SECONDS', '1'],
    ['SDLC_RUNNER_GIT_ALLOW_PLAINTEXT', 'yes'],
  ])('refuses %s=%s', (name, value) => {
    expect(refused({ [name]: value })).toThrow(RunnerError);
    expect(refused({ [name]: value })).toThrow(name);
  });

  it.each([
    'http://registry.npmjs.org/', // not an egress alias: unreachable from the sandbox
    'http://npm-proxy:4000/', // wrong port
    'http://user:secret@npm-proxy:4873/', // no credentials in the sandbox
    'file:///npm-proxy',
  ])('refuses the npm registry %s', (url) => {
    expect(() => settings({ SDLC_RUNNER_NPM_REGISTRY: url })).toThrow('SDLC_RUNNER_NPM_REGISTRY');
  });

  it('never puts the setting value into the error', () => {
    expect(refused({ SDLC_RUNNER_INSTANCE: 'secret-looking value' })).not.toThrow(/secret-looking/);
  });
});
