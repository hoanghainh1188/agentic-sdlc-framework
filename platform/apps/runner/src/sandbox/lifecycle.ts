// Creating and removing the Docker objects of one run (ADR-M25 §2.3, §2.8). Session 2 of C04
// wraps these in the full provisioning flow: unwrap the GitHub token, verify the Run Contract,
// claim the run, prepare the workspace, record run events.
//
// Order of creation: workspace volume → internal network → attach the allowed services → sandbox
// container → (workspace archive) → start. Any failure removes everything created so far.
import crypto from 'node:crypto';

import type { DockerClient } from '../docker/client.js';
import { RunnerError } from '../errors.js';
import { runLabels, runNames, type RunNames } from '../names.js';
import type { EgressService, RunnerSettings } from '../settings.js';
import { planEgress, runNetworkSpec } from './network.js';
import { buildSandboxSpec } from './spec.js';

/** Why provisioning stopped before the sandbox was ready (run event `provisioning_failed`). */
export type ProvisioningFailure =
  | 'token_unavailable' // the wrapped GitHub token was unknown, expired or already used
  | 'config_unavailable' // the project configuration could not be loaded
  | 'egress_not_enforceable'
  | 'clone_failed'
  | 'base_sha_not_found'
  | 'token_leaked' // the token was found in the clone's configuration (never expected)
  | 'workspace_too_large'
  | 'workspace_invalid' // a special file (device, FIFO, socket) in the repository
  | 'image_unavailable'
  | 'image_has_no_healthcheck'
  | 'sandbox_unhealthy'
  | 'sandbox_not_ready'
  | 'run_stopped' // the run left `provisioning` meanwhile (kill switch)
  | 'docker_error';

/** Why the runner removed a sandbox (run event `sandbox_removed`). */
export type TeardownReason = 'finished' | 'failed' | 'provisioning_failed' | 'killed' | 'orphan';

export interface CreateSandboxInput {
  readonly runId: string;
  readonly tenantId: string;
  /** Project image pinned by digest (config `sandbox.image`). */
  readonly image: string;
  /** The contract's `egress_allowlist`. */
  readonly egressAllowlist: readonly string[];
  /** Tar archive extracted into `/workspace` before the sandbox starts (the cloned repository). */
  readonly workspaceTar?: Buffer;
}

export interface Sandbox {
  readonly names: RunNames;
  readonly containerId: string;
  /** Hex digest of the image, for the run event `sandbox_created`. */
  readonly imageSha256: string;
  /** Random per run; the runner uses it to call the Agent Server (C05). Never logged. */
  readonly sessionApiKey: string;
}

export class ProvisioningError extends RunnerError {
  constructor(readonly reason: ProvisioningFailure) {
    super('runner.provisioning_failed', { reason });
  }
}

function randomKey(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function digestOf(image: string): string {
  const match = /@sha256:([0-9a-f]{64})$/.exec(image);
  if (!match) throw new ProvisioningError('image_unavailable');
  return match[1]!;
}

async function ensureImage(docker: DockerClient, image: string): Promise<void> {
  if (await docker.imageInspect(image)) return;
  try {
    await docker.imagePull(image);
  } catch {
    throw new ProvisioningError('image_unavailable');
  }
  if (!(await docker.imageInspect(image))) throw new ProvisioningError('image_unavailable');
}

/** Creates and starts the sandbox of one run, or removes everything and throws. */
export async function createSandbox(
  docker: DockerClient,
  settings: RunnerSettings,
  input: CreateSandboxInput,
): Promise<Sandbox> {
  const names = runNames(input.runId);
  const labels = runLabels(settings.instance, input.runId, input.tenantId);
  const egress = planEgress(input.egressAllowlist, settings.egressServices);
  if (!egress.ok) throw new ProvisioningError(egress.reason);
  const imageSha256 = digestOf(input.image);
  await ensureImage(docker, input.image);

  const sessionApiKey = randomKey();
  try {
    await docker.volumeCreate(names.volume, labels);
    await docker.networkCreate(runNetworkSpec(names, labels));
    for (const service of egress.services) {
      await docker.networkConnect(names.network, service.container, [service.alias]);
    }
    const spec = buildSandboxSpec(
      { names, labels, image: input.image, sessionApiKey, agentSecretKey: randomKey() },
      settings,
    );
    const containerId = await docker.containerCreate(names.container, spec);
    if (input.workspaceTar) await docker.putArchive(containerId, '/workspace', input.workspaceTar);
    await docker.containerStart(containerId);
    return { names, containerId, imageSha256, sessionApiKey };
  } catch (error) {
    await teardownSandbox(docker, settings.egressServices, input.runId);
    if (error instanceof RunnerError) throw error;
    throw new ProvisioningError('docker_error');
  }
}

export interface TeardownResult {
  readonly container: boolean;
  readonly network: boolean;
  readonly volume: boolean;
  readonly durationMs: number;
}

/**
 * Removes the sandbox, its network and its workspace volume (D-08 C04 AC5). Idempotent: objects
 * that are already gone are skipped, so it is safe after a success, a failure, a kill or a crash.
 * Every step runs even when an earlier one fails; the first error is thrown at the end.
 */
export async function teardownSandbox(
  docker: DockerClient,
  services: readonly EgressService[],
  runId: string,
): Promise<TeardownResult> {
  const started = Date.now();
  const names = runNames(runId);
  let firstError: Error | undefined;
  const attempt = async (step: () => Promise<boolean>): Promise<boolean> => {
    try {
      return await step();
    } catch (error) {
      firstError ??= error instanceof Error ? error : new ProvisioningError('docker_error');
      return false;
    }
  };

  const container = await attempt(() => docker.containerRemove(names.container));
  // Detach the shared services before the network can be removed. Only those actually attached:
  // Docker answers 500, not 404, for a container that is not on the network.
  const network = await docker.networkInspect(names.network).catch(() => undefined);
  const attached = new Set(Object.values(network?.Containers ?? {}).map((c) => c.Name));
  for (const service of services) {
    if (!attached.has(service.container)) continue;
    await attempt(() => docker.networkDisconnect(names.network, service.container));
  }
  const removedNetwork = await attempt(() => docker.networkRemove(names.network));
  const volume = await attempt(() => docker.volumeRemove(names.volume));
  if (firstError !== undefined) throw firstError;
  return { container, network: removedNetwork, volume, durationMs: Date.now() - started };
}
