// Shared set-up of the sandbox image live tests (C04 session 3, ADR-M25 §2.9, §2.10). Test
// infrastructure only, through the docker CLI; the sandboxes are created by the runner code.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { repoRoot } from '../../workspace/helpers';
import { docker, quietly, REGISTRY, startStub } from '../runner/live-helpers';

/** Same image as the Compose service npm-proxy. */
export const VERDACCIO =
  'verdaccio/verdaccio:6.9.3@sha256:3b0591ab7612f3ed232fe5bb5888b9418ac9f34d712db781a03bd8dad43b4aa8';

async function retry<T>(work: () => T, tries: number): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return work();
    } catch (error) {
      if (i >= tries) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

export interface Infrastructure {
  /** node24 by digest, as `sandbox.image` names it. */
  readonly image: string;
  /** Egress services for the runner settings: stub LiteLLM and the real Verdaccio. */
  readonly egressServices: string;
  cleanup(): void;
}

/**
 * Builds node24 with build.sh (reference by digest) and starts a stub LiteLLM and Verdaccio (the
 * repo's config) on a "platform" network.
 * - containerd image store (Docker Desktop): the local build already has a digest; the Engine
 *   there cannot push to a port published on the host.
 * - classic image store (Linux CI, the server): push to a throw-away registry:2 on 127.0.0.1.
 * `SDLC_SANDBOX_IMAGE` (name@sha256:…) skips the build.
 */
export async function startInfrastructure(suffix: string): Promise<Infrastructure> {
  const names = {
    registry: `sdlc-c04-img-registry-${suffix}`,
    platformNet: `sdlc-c04-img-platform-${suffix}`,
    litellm: `sdlc-c04-img-litellm-${suffix}`,
    npm: `sdlc-c04-img-npm-${suffix}`,
  };
  const cleanup = () => {
    quietly('rm', '-f', '-v', names.npm, names.litellm, names.registry);
    quietly('network', 'rm', names.platformNet);
  };
  try {
    const image = process.env.SDLC_SANDBOX_IMAGE || (await buildSandboxImage(names.registry));
    docker('pull', '-q', VERDACCIO);
    docker('network', 'create', names.platformNet);
    startStub(names.litellm, names.platformNet, 4000);
    const config = path.join(repoRoot(), 'platform/deploy/verdaccio/config.yaml');
    docker(
      'run',
      '-d',
      '--name',
      names.npm,
      '--network',
      names.platformNet,
      '--read-only',
      '--tmpfs',
      '/tmp',
      '--tmpfs',
      '/verdaccio/storage:mode=1777',
      '--cap-drop',
      'ALL',
      '-v',
      `${config}:/verdaccio/conf/config.yaml:ro`,
      VERDACCIO,
    );
    return {
      image,
      egressServices: `litellm=${names.litellm}:4000,npm-proxy=${names.npm}:4873`,
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

/**
 * Builds node24 and returns its reference by digest (see startInfrastructure). `registry` names a
 * throw-away registry:2 container, started only on the classic image store; the caller removes it.
 */
export async function buildSandboxImage(registry: string): Promise<string> {
  const script = path.join(repoRoot(), 'platform/sandbox-images/build.sh');
  const run = (args: string[], env: NodeJS.ProcessEnv = {}) =>
    execFileSync(script, args, {
      encoding: 'utf8',
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'inherit'],
      timeout: 900_000,
    }).trim();
  const local = run(['node24', '--no-push'], { SDLC_SANDBOX_REGISTRY: 'sdlc-test' });
  if (local.includes('@sha256:')) return local;
  docker('pull', '-q', REGISTRY);
  docker('run', '-d', '--name', registry, '-p', '127.0.0.1::5000', REGISTRY);
  const port = docker('port', registry, '5000/tcp').split('\n')[0]!.split(':').pop()!;
  return retry(() => run(['node24'], { SDLC_SANDBOX_REGISTRY: `localhost:${port}` }), 10);
}

/** Runs a shell command inside a sandbox (test harness only: the runner has no exec endpoint). */
export function sh(container: string, command: string): { code: number; out: string } {
  try {
    const out = execFileSync('docker', ['exec', container, 'sh', '-c', command], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300_000,
    });
    return { code: 0, out: out.trim() };
  } catch (error) {
    const e = error as { status?: number; stdout?: string };
    return { code: e.status ?? 1, out: (e.stdout ?? '').trim() };
  }
}

/** ENV of the base image and of platform/sandbox-images/node24/Dockerfile (not set by the runner). */
export const IMAGE_ENV = new Set([
  'PATH',
  'OPENHANDS_BUILD_GIT_SHA',
  'OPENHANDS_BUILD_GIT_REF',
  'ACP_NODE_DIR',
  'LC_ALL',
  'LANG',
  'LOG_JSON',
  'OH_ACP_SKILL_SOURCING',
  'EDITOR',
  'VISUAL',
  'GIT_EDITOR',
  'OPENVSCODE_SERVER_ROOT',
  'CHROME_BIN',
  'PUPPETEER_EXECUTABLE_PATH',
  'CHROMIUM_FLAGS',
  'LD_LIBRARY_PATH',
  'COREPACK_HOME',
  'COREPACK_ENABLE_DOWNLOAD_PROMPT',
  'COREPACK_ENABLE_AUTO_PIN',
  'NPM_CONFIG_UPDATE_NOTIFIER',
  'NPM_CONFIG_FUND',
  'NPM_CONFIG_AUDIT',
  'OH_CONVERSATIONS_PATH',
  'OH_BASH_EVENTS_DIR',
  'OH_WORKSPACE_PATH',
]);
