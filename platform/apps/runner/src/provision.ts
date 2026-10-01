// The runner's provisioning flow for one run (D-08 C04, ADR-M25 §2.8). Order:
//
// 1. verify the Run Contract (ADR-M22): refused contracts are recorded by `verifyRunContract`;
// 2. hold the run in this process and reserve its labelled workspace volume, so a crash after the
//    claim always leaves an object the clean-up can find (ADR-M25 §2.8);
// 3. claim the run `queued → provisioning` with one conditional update (QUESTIONS #35);
// 4. unwrap the GitHub token the worker handed over (QUESTIONS #44);
// 5. check that the contract's egress list can be enforced;
// 6. clone at `base_sha`, create `agent/INT-…`, pack the workspace          → `workspace_prepared`;
// 7. create the sandbox (network, services, container, archive)             → `sandbox_created`;
// 8. wait for the sandbox health check, then `provisioning → running`       → `sandbox_ready`.
//
// A failure after the claim removes everything created (the reserved volume included), records
// `provisioning_failed` (and `sandbox_removed` when a sandbox was created), and ends the run as `failed` with the reason as `stop_reason`. The clone on
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
import type { HeldRuns } from './held.js';
import {
  createSandbox,
  ProvisioningError,
  releaseWorkspace,
  reserveWorkspace,
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
  /**
   * Runs this process holds (ADR-M25 §2.8): a second provisioning of a held run is refused before
   * Docker, and the sweep skips held runs. One runner process per instance label: the clean-up at
   * start removes every object of the instance.
   */
  readonly held: HeldRuns;
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
      /**
       * The runner's own clone of an L1 run (`<workDir>/run-…` with `repo` and `home`), kept until
       * the run ends to compute the proposal outside the sandbox (C06 session 2b, ADR-M33 §2.9);
       * the caller removes it. Null for other runs: their clone is removed at once.
       */
      readonly cloneDir: string | null;
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
    if (error.key === 'runner.workspace.path_escape') return 'workspace_invalid';
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
  const runId = contract.run_id;
  const scope = deps.db.forTenant(parseTenantId(contract.tenant_id));
  if (!deps.held.hold(runId)) {
    return { ok: false, reason: 'run_not_startable', runId };
  }
  let reserved: 'created' | 'existed';
  try {
    reserved = await reserveWorkspace(deps.docker, deps.settings, runId, contract.tenant_id);
  } catch {
    // Nothing is claimed yet: the run stays `queued` for another attempt.
    deps.held.release(runId);
    return { ok: false, reason: 'docker_error', runId };
  }
  if (!(await scope.runs.claimForProvisioning(runId, clock(deps)))) {
    if (reserved === 'created') await releaseWorkspace(deps.docker, runId).catch(() => undefined);
    deps.held.release(runId);
    return { ok: false, reason: 'run_not_startable', runId };
  }

  const workDir = fs.mkdtempSync(path.join(ensureDir(deps.settings.workDir), 'run-'));
  // L1: the clone stays for the proposal (C06 session 2b); the token was only in git's environment.
  const keepClone = contract.autonomy_level === 'L1';
  let kept = false;
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
    await scope.runEvents.append(runId, 'workspace_prepared', {
      base_sha: contract.base_sha,
      duration_ms: Date.now() - cloneStarted,
    });
    if (!keepClone) fs.rmSync(workDir, { recursive: true, force: true });

    const startStarted = Date.now();
    sandboxCreated = true;
    const sandbox = await createSandbox(deps.docker, deps.settings, {
      runId: runId,
      tenantId: contract.tenant_id,
      image,
      egressAllowlist: contract.egress_allowlist,
      workspaceTar,
      workspaceReserved: true,
    });
    await scope.runEvents.append(runId, 'sandbox_created', {
      image_sha256: sandbox.imageSha256,
    });
    await waitUntilHealthy(deps, sandbox.containerId);
    const now = clock(deps);
    if (
      !(await scope.runs.transition(runId, {
        from: ['provisioning'],
        to: 'running',
        now,
        startedAt: now,
      }))
    ) {
      // Stopped meanwhile (kill switch, C11): do not keep the sandbox.
      throw new ProvisioningError('run_stopped');
    }
    await scope.runEvents.append(runId, 'sandbox_ready', {
      duration_ms: Date.now() - startStarted,
    });
    kept = keepClone;
    return { ok: true, contract, sandbox, cloneDir: keepClone ? workDir : null };
  } catch (error) {
    const reason = failureOf(error);
    try {
      await failRun(deps, scope, runId, reason, sandboxCreated);
    } finally {
      deps.held.release(runId);
    }
    return { ok: false, reason, runId };
  } finally {
    if (!kept) fs.rmSync(workDir, { recursive: true, force: true });
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
  const result = await teardownSandbox(deps.docker, runId);
  await scope.runEvents.append(runId, 'sandbox_removed', {
    reason,
    duration_ms: result.durationMs,
  });
  deps.held.release(runId);
}

async function failRun(
  deps: RunnerDeps,
  scope: TenantScope,
  runId: string,
  reason: ProvisioningFailure,
  sandboxCreated: boolean,
): Promise<void> {
  await scope.runEvents.append(runId, 'provisioning_failed', { reason });
  // The reserved workspace volume exists from before the claim, so there is always something to
  // remove. A clean-up error must not keep the run out of `failed`: the sweep retries the objects.
  await (
    sandboxCreated
      ? releaseSandbox(deps, scope.tenantId, runId, 'provisioning_failed')
      : teardownSandbox(deps.docker, runId)
  ).catch(() => undefined);
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
