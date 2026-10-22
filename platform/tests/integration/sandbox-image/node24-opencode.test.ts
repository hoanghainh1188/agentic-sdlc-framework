// X03 AC3 (ADR-M68 §5, §6; ADR-M88 §2.2): the sandbox image "node24-opencode" on a real Docker
// Engine, with the same egress as node24. `pnpm test:sandbox-image` (SDLC_SANDBOX_IMAGE_TEST=1; CI
// job `sandbox-image`). `SDLC_SANDBOX_IMAGE_OPENCODE` (name@sha256:…) skips the build.
//
// - Built FROM node24 by digest; the labels name the adapter and the OpenCode version.
// - The sandbox is created by the runner code under test (createSandbox), hardened by the guard
//   exactly as for OpenHands: the runner's environment allowlist, LiteLLM and the proxy only.
// - OpenCode serves on port 8000 and refuses callers without the session key; the agent's shell
//   has no session key and no model key (the key is set through the API, never the environment).
import crypto from 'node:crypto';

import { AGENT_ADAPTER_LABEL, AGENT_VERSION_LABEL } from '@sdlc/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createSandbox,
  DockerClient,
  packTar,
  runnerSettingsFromEnv,
  SANDBOX_ENV_ALLOWLIST,
  teardownSandbox,
  type RunnerSettings,
  type Sandbox,
} from '../../../apps/runner/src/index.js';
import { BUSYBOX, docker, dockerSocket } from '../runner/live-helpers';
import { IMAGE_ENV, sh, startInfrastructure, type Infrastructure } from './helpers';

const enabled = process.env.SDLC_SANDBOX_IMAGE_TEST === '1';
const suffix = crypto.randomBytes(4).toString('hex');
const RUN_ID = crypto.randomUUID();
const TENANT_ID = crypto.randomUUID();

describe.skipIf(!enabled)('X03 live: sandbox image node24-opencode', () => {
  let image: string;
  let client: DockerClient;
  let settings: RunnerSettings;
  let sandbox: Sandbox | undefined;
  let infra: Infrastructure | undefined;

  beforeAll(async () => {
    docker('pull', '-q', BUSYBOX);
    infra = await startInfrastructure(suffix, 'node24-opencode');
    image = infra.image;
    expect(image).toMatch(/@sha256:[0-9a-f]{64}$/);
    const socket = dockerSocket();
    client = new DockerClient({ socketPath: socket, timeoutMs: 900_000 });
    settings = runnerSettingsFromEnv({
      SDLC_RUNNER_DOCKER_SOCKET: socket,
      SDLC_RUNNER_INSTANCE: `x03-img-${suffix}`,
      SDLC_RUNNER_EGRESS_SERVICES: infra.egressServices,
      SDLC_RUNNER_NPM_REGISTRY: 'http://npm-proxy:4873/',
    });
    sandbox = await createSandbox(client, settings, {
      runId: RUN_ID,
      tenantId: TENANT_ID,
      image,
      adapter: 'opencode',
      egressAllowlist: ['litellm:4000', 'npm-proxy:4873'],
      workspaceTar: packTar([
        { type: 'dir', path: '.' },
        { type: 'file', path: 'README.md', content: Buffer.from('# x\n') },
      ]),
    });
    const deadline = Date.now() + 120_000;
    for (;;) {
      const info = await client.containerInspect(sandbox.containerId);
      if (info?.State.Health?.Status === 'healthy') break;
      if (!info?.State.Running || Date.now() > deadline) {
        throw new Error(`sandbox not healthy: ${info?.State.Health?.Status ?? 'stopped'}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }, 1_200_000);

  afterAll(async () => {
    if (client) await teardownSandbox(client, RUN_ID).catch(() => 0);
    infra?.cleanup();
  }, 120_000);

  const container = () => sandbox!.names.container;

  it('names its adapter and the OpenCode version in its labels; the binary is that version', () => {
    const labels = JSON.parse(
      docker('image', 'inspect', '--format', '{{json .Config.Labels}}', image),
    ) as Record<string, string>;
    expect(labels[AGENT_ADAPTER_LABEL]).toBe('opencode');
    expect(labels[AGENT_VERSION_LABEL]).toBe('1.18.35');
    expect(labels['sdlc.sandbox.base']).toMatch(/node24/);
    expect(sh(container(), 'HOME=/tmp opencode --version').out).toBe('1.18.35');
  });

  it('passes the image contract: user 10001, /workspace owned by 10001, read-only root', () => {
    expect(sh(container(), 'id -u').out).toBe('10001');
    expect(sh(container(), "stat -c '%u:%g' /workspace").out).toBe('10001:10001');
    expect(sh(container(), 'touch /usr/.w').code).not.toBe(0);
    expect(sh(container(), 'node --version').out).toMatch(/^v24\./);
  });

  it('OpenCode serves on port 8000 and refuses callers without the session key', () => {
    const status = (auth: string) =>
      sh(
        container(),
        `curl -s -o /dev/null -w '%{http_code}' ${auth} http://127.0.0.1:8000/session`,
      ).out;
    expect(status('')).toBe('401');
    expect(status("-u 'opencode:wrong-wrong-wrong-wrong-wrong-wrong'")).toBe('401');
  });

  it('OpenCode runs without the session key and without any model key in its environment', () => {
    // (`[ ]`: the pattern must not match this shell's own command line.)
    // The entry script removed SESSION_API_KEY and OH_SECRET_KEY before it started OpenCode; the
    // model key is set through the API, never the environment. The server password stays in
    // OpenCode's environment, so the agent's shell inherits it (gap 1, QUESTIONS #523): the
    // adapter fails a run whose configuration or tools change.
    const names = sh(
      container(),
      "for p in /proc/[0-9]*; do if tr '\\0' ' ' < $p/cmdline 2>/dev/null | grep -q 'opencode[ ]serve'; " +
        "then tr '\\0' '\\n' < $p/environ | cut -d= -f1; fi; done | sort -u",
    ).out.split('\n');
    expect(names).toContain('OPENCODE_SERVER_PASSWORD');
    for (const name of ['SESSION_API_KEY', 'OH_SECRET_KEY']) expect(names).not.toContain(name);
    expect(names.join(' ')).not.toMatch(/OPENAI|ANTHROPIC|LITELLM|_API_KEY/);
  });

  it('reaches nothing else: not the npm registry directly, not GitHub, not opencode.ai or models.dev', () => {
    const blocked = (url: string) =>
      sh(container(), `curl -sS -m 5 -o /dev/null ${url} && echo open || echo blocked`).out;
    expect(blocked('https://registry.npmjs.org/')).toBe('blocked');
    expect(blocked('https://api.github.com/')).toBe('blocked');
    expect(blocked('https://opencode.ai/')).toBe('blocked');
    expect(blocked('https://models.dev/')).toBe('blocked');
    expect(blocked('http://npm-proxy:4873/-/ping')).toBe('open');
  });

  it('receives environment variables from the allowlist only, as for OpenHands', async () => {
    const info = await client.containerInspect(sandbox!.containerId);
    const env = (info?.Config.Env ?? []).map((e) => e.split('=')[0]!);
    const set = new Set<string>(SANDBOX_ENV_ALLOWLIST);
    const runnerSet = env.filter((name) => !IMAGE_ENV.has(name) && !name.startsWith('OPENCODE_'));
    expect(runnerSet.every((name) => set.has(name))).toBe(true);
    expect(env.join(' ')).not.toMatch(/ANTHROPIC|OPENAI|LITELLM_MASTER|OPENBAO|BAO_|GITHUB|GH_/);
  });
});
