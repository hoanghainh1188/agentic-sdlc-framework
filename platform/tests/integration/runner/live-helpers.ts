// Shared set-up of the C04 live tests on a real Docker Engine (`pnpm test:runner`, ADR-M25).
// Test infrastructure only, through the docker CLI: the sandboxes themselves are always created
// by the runner code under test.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import type { DockerClient } from '../../../apps/runner/src/index.js';
import { repoRoot } from '../../workspace/helpers';

export const liveEnabled = process.env.SDLC_RUNNER_TEST === '1';

export const BUSYBOX =
  'docker.io/library/busybox:1.37.0@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e';
export const REGISTRY =
  'docker.io/library/registry:2.8.3@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373';

export function docker(...args: string[]): string {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function quietly(...args: string[]): void {
  try {
    docker(...args);
  } catch {
    // clean-up of test infrastructure: already gone is fine
  }
}

export function dockerSocket(): string {
  const host =
    process.env.DOCKER_HOST ??
    docker('context', 'inspect', '--format', '{{.Endpoints.docker.Host}}');
  if (!host.startsWith('unix://')) {
    throw new Error('the live runner test needs a local Unix socket');
  }
  return host.slice('unix://'.length);
}

/** A stub service: busybox answering TCP on `port`, on `network`. */
export function startStub(name: string, network: string, port: number, env: string[] = []): void {
  docker(
    'run',
    '-d',
    '--name',
    name,
    '--network',
    network,
    '--read-only',
    '--tmpfs',
    '/tmp',
    '--cap-drop',
    'ALL',
    ...env.flatMap((e) => ['-e', e]),
    BUSYBOX,
    'sh',
    '-c',
    `mkdir -p /tmp/www && exec httpd -f -p ${String(port)} -h /tmp/www`,
  );
}

/** Reads `probe:<name>:<value>` lines from a sandbox until `probe:done`. */
export async function waitForProbes(
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

export interface FixtureImage {
  /** Reference pinned by digest, as a project image is (config `sandbox.image`). */
  readonly image: string;
  cleanup(): void;
}

/**
 * Builds the fixture sandbox image (fixture/Dockerfile) and returns a reference pinned by digest.
 * - containerd image store (Docker Desktop): a local build already has a digest reference.
 * - classic image store (Linux CI): push it to a throw-away `registry:2` on localhost, remove the
 *   local copy, so the runner must pull the image by digest itself.
 */
export async function buildFixtureImage(suffix: string): Promise<FixtureImage> {
  const context = path.join(repoRoot(), 'platform/tests/integration/runner/fixture');
  const registry = `sdlc-c04-registry-${suffix}`;
  const built = `sdlc-test/c04-probe:${suffix}`;
  docker('build', '-q', '-t', built, context);
  const digests = JSON.parse(docker('inspect', '--format', '{{json .RepoDigests}}', built)) as
    string[] | null;
  if (digests && digests.length > 0) {
    const image = digests[0]!;
    return { image, cleanup: () => quietly('rmi', built) };
  }

  docker('pull', '-q', REGISTRY);
  docker('run', '-d', '--name', registry, '-p', '127.0.0.1::5000', REGISTRY);
  const port = docker('port', registry, '5000/tcp').split('\n')[0]!.split(':').pop()!;
  const pushed = `localhost:${port}/sdlc-test/c04-probe:${suffix}`;
  docker('tag', built, pushed);
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
  quietly('rmi', pushed, built);
  const image = `localhost:${port}/sdlc-test/c04-probe@${digest}`;
  return {
    image,
    cleanup: () => {
      quietly('rmi', image);
      quietly('rm', '-f', '-v', registry);
    },
  };
}
