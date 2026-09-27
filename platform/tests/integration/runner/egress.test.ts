// D-08 C04 AC1, AC4, AC5 on a real Docker Engine (ADR-M25 §2.2, §2.4, §2.8). Runs only with
// SDLC_RUNNER_TEST=1 (`pnpm test:runner`; CI job `compose`). Same test on Docker Desktop (dev) and
// Linux (CI and the server): egress is enforced by the network layout, not by host firewall rules.
//
// Set-up (test infrastructure only, through the docker CLI):
// - a throw-away local registry (`registry:2`, QUESTIONS #54) holding a fixture sandbox image that
//   probes the network from inside and prints the results (fixture/probe.sh);
// - a "platform" network with stub LiteLLM, stub npm proxy and a stub OpenBao, like `sdlc-net`.
// The sandboxes themselves are created by the runner code under test (createSandbox), through the
// guard, exactly as in production.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createSandbox,
  DockerClient,
  LABELS,
  packTar,
  runnerSettingsFromEnv,
  teardownSandbox,
  type RunnerSettings,
} from '../../../apps/runner/src/index.js';
import { repoRoot } from '../../workspace/helpers';

const enabled = process.env.SDLC_RUNNER_TEST === '1';
const BUSYBOX =
  'docker.io/library/busybox:1.37.0@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e';
const REGISTRY =
  'docker.io/library/registry:2.8.3@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373';
const CANARY = `sk-c04-canary-${crypto.randomBytes(8).toString('hex')}`;
const TENANT_A = '33333333-3333-4333-8333-333333333333';
const TENANT_B = '44444444-4444-4444-8444-444444444444';

const suffix = crypto.randomBytes(4).toString('hex');
const instance = `c04-test-${suffix}`;
const names = {
  registry: `sdlc-c04-registry-${suffix}`,
  platformNet: `sdlc-c04-platform-${suffix}`,
  litellm: `sdlc-c04-litellm-${suffix}`,
  npm: `sdlc-c04-npm-${suffix}`,
  openbao: `sdlc-c04-openbao-${suffix}`,
  hostListener: `sdlc-c04-host-listener-${suffix}`,
};
/** Port of a service in the host's network namespace (a container with `--network host`). */
const HOST_NS_PORT = 40_000 + crypto.randomInt(10_000);

function docker(...args: string[]): string {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function quietly(...args: string[]): void {
  try {
    docker(...args);
  } catch {
    // clean-up of test infrastructure: already gone is fine
  }
}

function dockerSocket(): string {
  const host =
    process.env.DOCKER_HOST ??
    docker('context', 'inspect', '--format', '{{.Endpoints.docker.Host}}');
  if (!host.startsWith('unix://'))
    throw new Error('the live runner test needs a local Unix socket');
  return host.slice('unix://'.length);
}

/** A stub service: busybox answering TCP on `port`, on the platform network. */
function startStub(name: string, port: number): void {
  docker(
    'run',
    '-d',
    '--name',
    name,
    '--network',
    names.platformNet,
    '--read-only',
    '--tmpfs',
    '/tmp',
    '--cap-drop',
    'ALL',
    '-e',
    `PROVIDER_KEY=${CANARY}`,
    BUSYBOX,
    'sh',
    '-c',
    `mkdir -p /tmp/www && exec httpd -f -p ${String(port)} -h /tmp/www`,
  );
}

async function waitForProbes(
  client: DockerClient,
  container: string,
): Promise<Map<string, string>> {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const logs = await client.containerLogs(container);
    if (logs.includes('probe:done')) {
      return new Map(
        [...logs.matchAll(/^probe:([a-z_0-9-]+):(\S+)$/gm)].map((m) => [m[1]!, m[2]!]),
      );
    }
    if (Date.now() > deadline) throw new Error(`probes did not finish:\n${logs}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

let builtTag: string | undefined;

/**
 * Builds the fixture image and returns a reference pinned by digest, as a project image would be.
 * - containerd image store (Docker Desktop): a local build already has a digest reference.
 * - classic image store (Linux CI): push it to a throw-away `registry:2` on localhost, remove the
 *   local copy, so the runner must pull the image by digest itself.
 */
async function fixtureImage(): Promise<string> {
  const context = path.join(repoRoot(), 'platform/tests/integration/runner/fixture');
  builtTag = `sdlc-test/c04-probe:${suffix}`;
  docker('build', '-q', '-t', builtTag, context);
  const local = docker('inspect', '--format', '{{json .RepoDigests}}', builtTag);
  const digests = JSON.parse(local) as string[] | null;
  if (digests && digests.length > 0) return digests[0]!;

  docker('pull', '-q', REGISTRY);
  docker('run', '-d', '--name', names.registry, '-p', '127.0.0.1::5000', REGISTRY);
  const port = docker('port', names.registry, '5000/tcp').split('\n')[0]!.split(':').pop()!;
  const pushed = `localhost:${port}/sdlc-test/c04-probe:${suffix}`;
  docker('tag', builtTag, pushed);
  // The registry needs a moment after start; retry the push a few times.
  for (let i = 0; ; i++) {
    try {
      docker('push', '-q', pushed);
      break;
    } catch (error) {
      if (i >= 10) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  const digest = docker('inspect', '--format', '{{index .RepoDigests 0}}', pushed).split('@')[1]!;
  quietly('rmi', pushed, builtTag);
  builtTag = undefined;
  return `localhost:${port}/sdlc-test/c04-probe@${digest}`;
}

function targets(lines: string[]): Buffer {
  return packTar([
    { type: 'dir', path: '.' },
    { type: 'file', path: 'probe-targets', content: Buffer.from(`${lines.join('\n')}\n`) },
  ]);
}

describe.skipIf(!enabled)('C04 live: sandbox egress and hardening on Docker', () => {
  let client: DockerClient;
  let settings: RunnerSettings;
  let image: string;
  let hostServer: net.Server;
  let hostPort: number;
  let hostAddresses: string[];
  const runA = crypto.randomUUID();
  const runB = crypto.randomUUID();

  beforeAll(async () => {
    docker('pull', '-q', BUSYBOX);
    image = await fixtureImage();

    docker('network', 'create', names.platformNet);
    startStub(names.litellm, 4000);
    startStub(names.npm, 4873);
    startStub(names.openbao, 8200);

    // A service on the host, to prove the sandbox cannot reach the host either.
    hostServer = net.createServer((socket) => socket.end());
    await new Promise<void>((resolve) => hostServer.listen(0, '0.0.0.0', resolve));
    hostPort = (hostServer.address() as net.AddressInfo).port;
    // And a service in the host network namespace of the Docker Engine: on Linux that is the
    // host itself; on Docker Desktop it is the Linux VM. The sandbox must not reach it on any of
    // the host's addresses (loopback, LAN, every Docker bridge).
    docker(
      'run',
      '-d',
      '--name',
      names.hostListener,
      '--network',
      'host',
      '--read-only',
      '--tmpfs',
      '/tmp',
      '--cap-drop',
      'ALL',
      BUSYBOX,
      'sh',
      '-c',
      `mkdir -p /tmp/www && exec httpd -f -p ${String(HOST_NS_PORT)} -h /tmp/www`,
    );
    hostAddresses = docker(
      'run',
      '--rm',
      '--network',
      'host',
      BUSYBOX,
      'sh',
      '-c',
      "ip -4 -o addr | awk '{print $4}' | cut -d/ -f1",
    )
      .split('\n')
      .filter((ip) => /^[0-9.]+$/.test(ip));

    // The canary is in the runner's own environment: it must never reach a sandbox (AC4).
    process.env.ANTHROPIC_API_KEY = CANARY;
    settings = runnerSettingsFromEnv({
      SDLC_RUNNER_DOCKER_SOCKET: dockerSocket(),
      SDLC_RUNNER_INSTANCE: instance,
      SDLC_RUNNER_SANDBOX_MEMORY_MB: '256',
      SDLC_RUNNER_EGRESS_SERVICES: `litellm=${names.litellm}:4000,npm-proxy=${names.npm}:4873`,
      SDLC_RUNNER_NPM_REGISTRY: 'http://npm-proxy:4873/',
    });
    client = new DockerClient({ socketPath: settings.dockerSocket, timeoutMs: 120_000 });
  }, 300_000);

  afterAll(async () => {
    delete process.env.ANTHROPIC_API_KEY;
    if (client) {
      for (const run of [runA, runB]) {
        await teardownSandbox(client, settings.egressServices, run).catch(() => undefined);
      }
    }
    hostServer?.close();
    for (const name of [
      names.litellm,
      names.npm,
      names.openbao,
      names.registry,
      names.hostListener,
    ]) {
      quietly('rm', '-f', '-v', name);
    }
    quietly('network', 'rm', names.platformNet);
    if (image) quietly('rmi', image);
    if (builtTag) quietly('rmi', builtTag);
  }, 120_000);

  it('confines each sandbox to LiteLLM and the package proxy (AC1, AC4), then removes it (AC5)', async () => {
    // Positive control: from an ordinary (non-internal) network, the host listener IS reachable,
    // so "blocked" below means the sandbox network stops it, not that the listener is missing.
    expect(hostAddresses).toContain('127.0.0.1');
    const platformGateway = docker(
      'network',
      'inspect',
      names.platformNet,
      '--format',
      '{{(index .IPAM.Config 0).Gateway}}',
    );
    expect(
      docker(
        'run',
        '--rm',
        '--network',
        names.platformNet,
        BUSYBOX,
        'sh',
        '-c',
        `nc -z -w 3 ${platformGateway} ${String(HOST_NS_PORT)} && echo open || echo blocked`,
      ),
    ).toBe('open');

    // Run B first: run A tries to reach it.
    const b = await createSandbox(client, settings, {
      runId: runB,
      tenantId: TENANT_B,
      image,
      egressAllowlist: ['litellm:4000'],
      workspaceTar: targets(['litellm_from_b litellm 4000', 'npm_from_b npm-proxy 4873']),
    });
    const probesB = await waitForProbes(client, b.containerId);
    expect(probesB.get('litellm_from_b')).toBe('open');
    expect(probesB.get('npm_from_b')).toBe('blocked'); // not in run B's allowlist
    const infoB = await client.containerInspect(b.containerId);
    const ipB = (Object.values(infoB!.NetworkSettings.Networks)[0] as { IPAddress: string })
      .IPAddress;

    const a = await createSandbox(client, settings, {
      runId: runA,
      tenantId: TENANT_A,
      image,
      egressAllowlist: ['litellm:4000', 'npm-proxy:4873'],
      workspaceTar: targets([
        'litellm litellm 4000',
        'npm_proxy npm-proxy 4873',
        `openbao_by_name ${names.openbao} 8200`,
        'openbao_alias openbao 8200',
        `litellm_by_container_name ${names.litellm} 4000`,
        'internet_ip 1.1.1.1 443',
        'github api.github.com 443',
        `host_docker_internal host.docker.internal ${String(hostPort)}`,
        `other_sandbox_by_name sdlc-sandbox-${runB} 8000`,
        `other_sandbox_by_ip ${ipB} 8000`,
        ...hostAddresses.flatMap((ip, i) => [
          `host_ns_${String(i)} ${ip} ${String(HOST_NS_PORT)}`,
          `host_process_${String(i)} ${ip} ${String(hostPort)}`,
        ]),
      ]),
    });
    const probes = await waitForProbes(client, a.containerId);
    expect(Object.fromEntries(probes)).toEqual({
      litellm: 'open',
      npm_proxy: 'open',
      openbao_by_name: 'blocked',
      openbao_alias: 'blocked',
      // Docker's DNS also knows an attached container by its own name: the same allowed service
      // and port, nothing more. Its other networks (OpenBao above) stay out of reach.
      litellm_by_container_name: 'open',
      internet_ip: 'blocked',
      github: 'blocked',
      host_docker_internal: 'blocked',
      other_sandbox_by_name: 'blocked',
      other_sandbox_by_ip: 'blocked',
      ...Object.fromEntries(
        hostAddresses.flatMap((_ip, i) => [
          [`host_ns_${String(i)}`, 'blocked'],
          [`host_process_${String(i)}`, 'blocked'],
        ]),
      ),
      default_route: 'none',
      rootfs: 'readonly',
      workspace: 'writable',
      uid: '10001',
      canary: 'absent',
      secret_env: 'absent',
    });

    // AC4 from the outside: no secret value in the sandbox definition, no socket or host mount.
    const info = await client.containerInspect(a.containerId);
    expect(JSON.stringify(info)).not.toContain(CANARY);
    expect(info!.Mounts.map((m) => [m.Type, m.Destination])).toEqual([['volume', '/workspace']]);
    expect(Object.keys(info!.NetworkSettings.Networks)).toEqual([`sdlc-run-${runA}`]);
    expect(info!.HostConfig).toMatchObject({
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      Privileged: false,
      NetworkMode: `sdlc-run-${runA}`,
    });
    expect((await client.networkInspect(`sdlc-run-${runA}`))?.Internal).toBe(true);

    // AC5: teardown removes the containers, networks and workspaces of both runs and detaches the
    // shared services; the services themselves keep running.
    for (const run of [runA, runB]) {
      expect(await teardownSandbox(client, settings.egressServices, run)).toMatchObject({
        container: true,
        network: true,
        volume: true,
      });
    }
    const labels = { [LABELS.instance]: instance };
    expect(await client.containerList(labels)).toEqual([]);
    expect(await client.networkList(labels)).toEqual([]);
    expect(await client.volumeList(labels)).toEqual([]);
    expect(docker('inspect', '--format', '{{.State.Running}}', names.litellm)).toBe('true');
    expect(
      Object.keys(
        JSON.parse(
          docker('inspect', '--format', '{{json .NetworkSettings.Networks}}', names.litellm),
        ) as object,
      ),
    ).toEqual([names.platformNet]);
  }, 300_000);
});
