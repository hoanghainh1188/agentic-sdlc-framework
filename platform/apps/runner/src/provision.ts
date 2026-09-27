// The runner's provisioning flow for one run (D-08 C04, ADR-M25 §2.8). Order:
//
// 1. verify the Run Contract (ADR-M22): refused contracts are recorded by `verifyRunContract`;
// 2. claim the run `queued → provisioning` with one conditional update (QUESTIONS #35);
// 3. unwrap the GitHub token the worker handed over (QUESTIONS #44);
// 4. check that the contract's egress list can be enforced;
// 5. clone at `base_sha`, create `agent/INT-…`, pack the workspace          → `workspace_prepared`;
// 6. create the sandbox (volume, network, services, container, archive)     → `sandbox_created`;
// 7. wait for the sandbox health check, then `provisioning → running`       → `sandbox_ready`.
//
// A failure after the claim removes everything created, records `provisioning_failed` and
// `sandbox_removed`, and ends the run as `failed` with the reason as `stop_reason`. The clone on
// the runner's disk is always removed; the token lives only in memory for the clone.
import fs from 'node:fs';
import path from 'node:path';

import type {
  RedactedSecret,
  RunContract,
  RunContractRejectReason,
  RunContractVerifier,
  SecretUnwrapper,
} from '@sdlc/contracts';
import {
  loadEffectiveConfig,
  parseTenantId,
  verifyRunContract,
  type PlatformDatabase,
  type TenantScope,
} from '@sdlc/core';

import type { DockerClient } from './docker/client.js';
import { RunnerError } from './errors.js';
import {
  createSandbox,
  ProvisioningError,
  teardownSandbox,
  type ProvisioningFailure,
  type Sandbox,
  type TeardownReason,
} from './sandbox/lifecycle.js';
import { planEgress } from './sandbox/network.js';
import type { RunnerSettings } from './settings.js';
import { CloneError, cloneForRun } from './workspace/git.js';
import { packDirectory } from './workspace/tar.js';

export interface RunnerDeps {
  readonly db: PlatformDatabase;
  readonly docker: DockerClient;
  readonly settings: RunnerSettings;
  readonly verifier: RunContractVerifier;
  readonly unwrapper: SecretUnwrapper;
  /** Default: `new Date()`. */
  readonly now?: () => Date;
}

export interface ProvisionRequest {
  /** `{ contract, signature }` from the worker (ADR-M22). */
  readonly envelope: unknown;
  /** Single-use OpenBao wrapping token around `{ token }` (QUESTIONS #44). */
  readonly wrappedGitToken: RedactedSecret;
}

export type ProvisionResult =
  | {
      readonly ok: true;
      readonly contract: RunContract;
      readonly sandbox: Sandbox;
    }
  | {
      readonly ok: false;
      readonly reason: RunContractRejectReason | ProvisioningFailure;
      readonly runId?: string;
    };

const HEALTH_POLL_MS = 500;

function clock(deps: RunnerDeps): Date {
  return deps.now ? deps.now() : new Date();
}

function failureOf(error: unknown): ProvisioningFailure {
  if (error instanceof ProvisioningError) return error.reason;
  if (error instanceof CloneError) return error.reason;
  if (error instanceof RunnerError) {
    if (error.key === 'runner.workspace.too_large') return 'workspace_too_large';
    if (error.key === 'runner.workspace.special_file') return 'workspace_invalid';
  }
  return 'docker_error';
}

export async function provisionRun(
  deps: RunnerDeps,
  request: ProvisionRequest,
): Promise<ProvisionResult> {
  const verified = await verifyRunContract(deps.db, request.envelope, {
    verifier: deps.verifier,
    ...(deps.now ? { now: deps.now } : {}),
  });
  if (!verified.ok) {
    return {
      ok: false,
      reason: verified.reason,
      ...(verified.runId ? { runId: verified.runId } : {}),
    };
  }
  const { contract } = verified;
  const scope = deps.db.forTenant(parseTenantId(contract.tenant_id));
  if (!(await scope.runs.claimForProvisioning(contract.run_id, clock(deps)))) {
    return { ok: false, reason: 'run_not_startable', runId: contract.run_id };
  }

  const workDir = fs.mkdtempSync(path.join(ensureDir(deps.settings.workDir), 'run-'));
  let sandboxCreated = false;
  try {
    const token = await unwrapToken(deps.unwrapper, request.wrappedGitToken);
    if (!planEgress(contract.egress_allowlist, deps.settings.egressServices).ok) {
      throw new ProvisioningError('egress_not_enforceable');
    }
    const image = await projectImage(scope, contract.project_id);

    const cloneStarted = Date.now();
    const repoDir = await cloneForRun(deps.settings.git, {
      repo: contract.repo,
      baseSha: contract.base_sha,
      branch: contract.branch,
      token,
      dir: workDir,
    });
    const workspaceTar = packDirectory(repoDir, deps.settings.workspaceMaxBytes);
    await scope.runEvents.append(contract.run_id, 'workspace_prepared', {
      base_sha: contract.base_sha,
      duration_ms: Date.now() - cloneStarted,
    });
    fs.rmSync(workDir, { recursive: true, force: true });

    const startStarted = Date.now();
    sandboxCreated = true;
    const sandbox = await createSandbox(deps.docker, deps.settings, {
      runId: contract.run_id,
      tenantId: contract.tenant_id,
      image,
      egressAllowlist: contract.egress_allowlist,
      workspaceTar,
    });
    await scope.runEvents.append(contract.run_id, 'sandbox_created', {
      image_sha256: sandbox.imageSha256,
    });
    await waitUntilHealthy(deps, sandbox.containerId);
    const now = clock(deps);
    if (
      !(await scope.runs.transition(contract.run_id, {
        from: ['provisioning'],
        to: 'running',
        now,
        startedAt: now,
      }))
    ) {
      // Stopped meanwhile (kill switch, C11): do not keep the sandbox.
      throw new ProvisioningError('run_stopped');
    }
    await scope.runEvents.append(contract.run_id, 'sandbox_ready', {
      duration_ms: Date.now() - startStarted,
    });
    return { ok: true, contract, sandbox };
  } catch (error) {
    const reason = failureOf(error);
    await failRun(deps, scope, contract.run_id, reason, sandboxCreated);
    return { ok: false, reason, runId: contract.run_id };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * Removes the sandbox of a run and records `sandbox_removed` (D-08 C04 AC5). For the end of a run
 * (C05), a kill (C11) or a failure. The run status is the caller's: this only cleans up.
 */
export async function releaseSandbox(
  deps: RunnerDeps,
  tenantId: string,
  runId: string,
  reason: TeardownReason,
): Promise<void> {
  const scope = deps.db.forTenant(parseTenantId(tenantId));
  const result = await teardownSandbox(deps.docker, deps.settings.egressServices, runId);
  await scope.runEvents.append(runId, 'sandbox_removed', {
    reason,
    duration_ms: result.durationMs,
  });
}

async function failRun(
  deps: RunnerDeps,
  scope: TenantScope,
  runId: string,
  reason: ProvisioningFailure,
  sandboxCreated: boolean,
): Promise<void> {
  await scope.runEvents.append(runId, 'provisioning_failed', { reason });
  if (sandboxCreated) await releaseSandbox(deps, scope.tenantId, runId, 'provisioning_failed');
  const now = clock(deps);
  await scope.runs.transition(runId, {
    from: ['provisioning'],
    to: 'failed',
    now,
    stopReason: reason,
    finishedAt: now,
  });
}

async function unwrapToken(
  unwrapper: SecretUnwrapper,
  wrapped: RedactedSecret,
): Promise<RedactedSecret> {
  try {
    const fields = await unwrapper.unwrap(wrapped);
    const token = fields.token;
    if (!token) throw new ProvisioningError('token_unavailable');
    return token;
  } catch {
    // Unknown, expired or already used: maybe someone else unwrapped it (ADR-M25 §2.11).
    throw new ProvisioningError('token_unavailable');
  }
}

async function projectImage(scope: TenantScope, projectId: string): Promise<string> {
  try {
    return (await loadEffectiveConfig(scope.projectConfigs, projectId)).config.sandbox.image;
  } catch {
    throw new ProvisioningError('config_unavailable');
  }
}

/** Waits for the image's health check (image contract, ADR-M25 §2.3). */
async function waitUntilHealthy(deps: RunnerDeps, containerId: string): Promise<void> {
  const deadline = Date.now() + deps.settings.readyTimeoutMs;
  for (;;) {
    const info = await deps.docker.containerInspect(containerId);
    const health = info?.State.Health?.Status;
    if (!info?.State.Running) throw new ProvisioningError('sandbox_unhealthy');
    if (health === undefined) throw new ProvisioningError('image_has_no_healthcheck');
    if (health === 'healthy') return;
    if (health === 'unhealthy') throw new ProvisioningError('sandbox_unhealthy');
    if (Date.now() >= deadline) throw new ProvisioningError('sandbox_not_ready');
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
  }
}

function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
