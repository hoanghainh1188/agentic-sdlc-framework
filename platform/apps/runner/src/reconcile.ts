// Clean-up after a crash (D-08 C04 AC5, ADR-M25 §2.8).
//
// - `reconcileOnStart`: when the runner starts, nothing of this runner instance can still be in use
//   (the session keys and the in-memory state of the old process are gone). Every labelled object
//   is removed. Runs still `provisioning`, `running` or `stopping` end as `failed` with
//   `runner_restarted`; their outputs are lost.
// - `sweepOrphans`: at a fixed interval, removes the objects of runs this process does not hold.
//   A run that has not reached a final status ends as `failed` with `sandbox_lost`.
//
// The runner trusts the `sdlc.*` labels only on objects that carry its own instance label
// (`runOfLabels`). Every run is handled on its own: an error on one run is counted and the next
// run is still handled, so one broken object never blocks the clean-up of the others.
import fs from 'node:fs';
import path from 'node:path';

import type { RunStatus } from '@sdlc/contracts';
import { parseTenantId, type PlatformDatabase } from '@sdlc/core';

import type { DockerClient } from './docker/client.js';
import type { HeldRuns } from './held.js';
import { LABELS, MANAGED_BY, runOfLabels, type LabelledRun } from './names.js';
import { teardownSandbox, type TeardownReason } from './sandbox/lifecycle.js';
import type { RunnerSettings } from './settings.js';

export interface ReconcileDeps {
  readonly db: PlatformDatabase;
  readonly docker: DockerClient;
  readonly settings: RunnerSettings;
  /** Default: `new Date()`. */
  readonly now?: () => Date;
}

export interface ReconcileResult {
  /** Runs whose objects were found (and removed, unless `errors` counts them). */
  readonly runs: number;
  /** Runs that were not final and are now `failed`. */
  readonly failedRuns: number;
  /** Runs whose clean-up failed; the next sweep tries again. */
  readonly errors: number;
}

/** States of a run whose sandbox may exist. `queued` has at most a reserved workspace volume. */
const ACTIVE: readonly RunStatus[] = ['provisioning', 'running', 'stopping'];

/** Every run with at least one labelled object of this runner instance. */
export async function findRunObjects(
  docker: DockerClient,
  instance: string,
): Promise<LabelledRun[]> {
  const filter = { [LABELS.managed]: MANAGED_BY, [LABELS.instance]: instance };
  const [containers, networks, volumes] = await Promise.all([
    docker.containerList(filter),
    docker.networkList(filter),
    docker.volumeList(filter),
  ]);
  const runs = new Map<string, LabelledRun>();
  for (const labels of [
    ...containers.map((c) => c.Labels),
    ...networks.map((n) => n.Labels),
    ...volumes.map((v) => v.Labels),
  ]) {
    const run = runOfLabels(labels, instance);
    if (run && !runs.has(run.runId)) runs.set(run.runId, run);
  }
  return [...runs.values()];
}

/** Clean-up when the runner starts: every object of this instance, and the old clones. */
export async function reconcileOnStart(deps: ReconcileDeps): Promise<ReconcileResult> {
  removeOldClones(deps.settings.workDir);
  return cleanUp(deps, await findRunObjects(deps.docker, deps.settings.instance), {
    teardown: 'runner_restarted',
    stopReason: 'runner_restarted',
  });
}

/** Periodic sweep: objects of runs this process does not hold. */
export async function sweepOrphans(deps: ReconcileDeps, held: HeldRuns): Promise<ReconcileResult> {
  const runs = await findRunObjects(deps.docker, deps.settings.instance);
  return cleanUp(
    deps,
    runs.filter((run) => !held.has(run.runId)),
    { teardown: 'orphan', stopReason: 'sandbox_lost' },
  );
}

async function cleanUp(
  deps: ReconcileDeps,
  runs: readonly LabelledRun[],
  why: { readonly teardown: TeardownReason; readonly stopReason: string },
): Promise<ReconcileResult> {
  let failedRuns = 0;
  let errors = 0;
  for (const run of runs) {
    try {
      if (await cleanUpRun(deps, run, why)) failedRuns += 1;
    } catch {
      errors += 1;
    }
  }
  return { runs: runs.length, failedRuns, errors };
}

/** Returns true when the run was not final and is now `failed`. */
async function cleanUpRun(
  deps: ReconcileDeps,
  labelled: LabelledRun,
  why: { readonly teardown: TeardownReason; readonly stopReason: string },
): Promise<boolean> {
  const result = await teardownSandbox(deps.docker, deps.settings.egressServices, labelled.runId);
  const scope = deps.db.forTenant(parseTenantId(labelled.tenantId));
  const run = await scope.runs.getById(labelled.runId);
  // No row (another database, a deleted test tenant) or still `queued` (a workspace reserved just
  // before a crash; the claim never happened): the objects are gone, there is nothing to record.
  if (!run || run.status === 'queued') return false;

  let failed = false;
  if (ACTIVE.includes(run.status)) {
    const now = deps.now ? deps.now() : new Date();
    failed = await scope.runs.transition(run.id, {
      from: ACTIVE,
      to: 'failed',
      now,
      stopReason: why.stopReason,
      finishedAt: now,
    });
    if (failed) {
      await scope.runEvents.append(run.id, 'run_abandoned', { previous_status: run.status });
    }
  }
  await scope.runEvents.append(run.id, 'sandbox_removed', {
    reason: failed ? why.teardown : 'orphan',
    duration_ms: result.durationMs,
  });
  return failed;
}

/** Clones of the old process (`run-*` in the work folder) never went into a sandbox: remove them. */
function removeOldClones(workDir: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(workDir);
  } catch {
    return; // no work folder yet
  }
  for (const entry of entries) {
    if (entry.startsWith('run-')) {
      fs.rmSync(path.join(workDir, entry), { recursive: true, force: true });
    }
  }
}
