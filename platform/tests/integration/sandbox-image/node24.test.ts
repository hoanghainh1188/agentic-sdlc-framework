// D-08 C04 AC1, AC4, ADR-M25 §2.3, §2.9, §2.10: the sandbox image "node24" on a real Docker
// Engine, with the real package proxy (Verdaccio, pinned as in Compose). `pnpm test:sandbox-image`
// (SDLC_SANDBOX_IMAGE_TEST=1; CI job `sandbox-image`). Needs internet for Verdaccio's uplink and,
// the first time, for the Agent Server base image. No key of any kind.
//
// - The image is built from platform/sandbox-images/node24 with build.sh and pushed to a
//   throw-away registry:2 on 127.0.0.1, so it is used by digest exactly as on the server. CI
//   may pass an already built reference in SDLC_SANDBOX_IMAGE (name@sha256:…).
// - The sandbox is created by the runner code under test (createSandbox), hardened by the guard.
// - The checks run inside the sandbox through `docker exec` (test harness only; the runner has no
//   exec endpoint): Node 24, pnpm through corepack and the proxy, workspace owner, environment
//   allowlist, and no way out except LiteLLM and the proxy.
import crypto from 'node:crypto';

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

describe.skipIf(!enabled)('C04 live: sandbox image node24 with the package proxy', () => {
  let image: string;
  let client: DockerClient;
  let settings: RunnerSettings;
  let sandbox: Sandbox | undefined;
  let infra: Infrastructure | undefined;

  beforeAll(async () => {
    docker('pull', '-q', BUSYBOX);
    infra = await startInfrastructure(suffix);
    image = infra.image;
    expect(image).toMatch(/@sha256:[0-9a-f]{64}$/);
    const socket = dockerSocket();
    client = new DockerClient({ socketPath: socket, timeoutMs: 900_000 });
    settings = runnerSettingsFromEnv({
      SDLC_RUNNER_DOCKER_SOCKET: socket,
      SDLC_RUNNER_INSTANCE: `c04-img-${suffix}`,
      SDLC_RUNNER_EGRESS_SERVICES: infra.egressServices,
      SDLC_RUNNER_NPM_REGISTRY: 'http://npm-proxy:4873/',
    });
    const workspace = packTar([
      { type: 'dir', path: '.' },
      {
        type: 'file',
        path: 'package.json',
        content: Buffer.from(
          JSON.stringify({ name: 'pilot', private: true, packageManager: 'pnpm@10.34.5' }),
        ),
      },
    ]);
    sandbox = await createSandbox(client, settings, {
      runId: RUN_ID,
      tenantId: TENANT_ID,
      image,
      egressAllowlist: ['litellm:4000', 'npm-proxy:4873'],
      workspaceTar: workspace,
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

  it('passes the image contract: healthy, user 10001, /workspace owned by 10001 (ADR-M25 §2.3)', () => {
    expect(sh(container(), 'id -u').out).toBe('10001');
    expect(sh(container(), "stat -c '%u:%g' /workspace").out).toBe('10001:10001');
    expect(sh(container(), 'touch /workspace/.w && echo ok').out).toBe('ok');
    expect(sh(container(), 'touch /usr/.w').code).not.toBe(0); // read-only root
  });

  it('has Node.js 24 and keeps the Agent Server state out of the repository', () => {
    expect(sh(container(), 'node --version').out).toMatch(/^v24\./);
    expect(sh(container(), 'ls -A /workspace').out.split('\n').sort()).toEqual([
      '.w',
      'package.json',
    ]);
  });

  it('gets packages and the pinned pnpm through the proxy (QUESTIONS #59 C)', () => {
    expect(sh(container(), 'npm view left-pad@1.3.0 version').out).toBe('1.3.0');
    expect(sh(container(), 'cd /workspace && pnpm --version').out).toBe('10.34.5');
  });

  it('reaches nothing else: not the npm registry directly, not GitHub (AC1)', () => {
    const blocked = (url: string) =>
      sh(container(), `curl -sS -m 5 -o /dev/null ${url} && echo open || echo blocked`).out;
    expect(blocked('https://registry.npmjs.org/')).toBe('blocked');
    expect(blocked('https://api.github.com/')).toBe('blocked');
    expect(blocked('http://npm-proxy:4873/-/ping')).toBe('open');
  });

  it('receives environment variables from the allowlist only (AC4)', async () => {
    const info = await client.containerInspect(sandbox!.containerId);
    const env = (info?.Config.Env ?? []).map((e) => e.split('=')[0]!);
    const set = new Set<string>(SANDBOX_ENV_ALLOWLIST);
    // The image's own ENV lines are part of Config.Env; the runner-set ones must be allowlisted.
    const runnerSet = env.filter((name) => !IMAGE_ENV.has(name));
    expect(runnerSet.every((name) => set.has(name))).toBe(true);
    expect(env.join(' ')).not.toMatch(/ANTHROPIC|OPENAI|LITELLM_MASTER|OPENBAO|BAO_|GITHUB|GH_/);
  });
});
