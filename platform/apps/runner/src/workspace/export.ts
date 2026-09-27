// Reads the run's workspace out of its sandbox, and stores the proposal of an L1 run (task C06
// session 2b, D-09 T09, design/ADR-M33 §2.9, QUESTIONS #111).
//
// `exportWorkspace` reads `/workspace` with Docker's archive endpoint only from the run's own
// sandbox: the container must have the run's sandbox name and this runner's instance and run
// labels. The archive is untrusted (`untar.ts`).
//
// `storeProposal` mirrors it onto the runner's clone, computes the patch with hardened git
// (`proposal.ts`), stores it through the evidence store at `<intent>/<run>.patch` (the store adds
// its key prefix and the tenant; never overwritten), records the evidence item and the run event
// `proposal_stored` (hash and counts only).
import path from 'node:path';

import type { EvidenceStore, RunContract } from '@sdlc/contracts';
import { parseTenantId, type PlatformDatabase } from '@sdlc/core';

import type { DockerClient } from '../docker/client.js';
import { RunnerError } from '../errors.js';
import { runNames, runOfLabels } from '../names.js';
import type { RunnerSettings } from '../settings.js';
import { computeProposal, mirrorWorkspace } from './proposal.js';
import { untarWorkspace, type WorkspaceEntry } from './untar.js';

/** Upper bound of the entries of a workspace archive. */
export const MAX_WORKSPACE_ENTRIES = 100_000;
/** Tar headers and padding on top of the file contents, per entry at most 1.5 KiB. */
const ARCHIVE_OVERHEAD_PER_ENTRY = 1536;

export async function exportWorkspace(
  docker: DockerClient,
  settings: Pick<RunnerSettings, 'instance' | 'workspaceMaxBytes'>,
  runId: string,
): Promise<WorkspaceEntry[]> {
  const names = runNames(runId);
  const info = await docker.containerInspect(names.container);
  if (
    !info ||
    info.Name !== `/${names.container}` ||
    runOfLabels(info.Config?.Labels, settings.instance)?.runId !== runId
  ) {
    throw new RunnerError('runner.workspace.not_own_sandbox');
  }
  const archive = await docker.getArchive(
    names.container,
    '/workspace',
    settings.workspaceMaxBytes + MAX_WORKSPACE_ENTRIES * ARCHIVE_OVERHEAD_PER_ENTRY,
  );
  return untarWorkspace(archive, 'workspace', {
    maxBytes: settings.workspaceMaxBytes,
    maxEntries: MAX_WORKSPACE_ENTRIES,
  });
}

export interface ProposalDeps {
  readonly db: PlatformDatabase;
  readonly docker: DockerClient;
  readonly settings: RunnerSettings;
  readonly evidence: EvidenceStore;
}

export interface StoredProposal {
  readonly uri: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly changedFiles: number;
}

/**
 * `cloneDir` is the folder of the runner's clone (with `repo` and `home`), kept for the L1 run by
 * `provisionRun`. Throws a `RunnerError` or `EvidenceError`; the caller fails the run.
 */
export async function storeProposal(
  deps: ProposalDeps,
  contract: RunContract,
  cloneDir: string,
): Promise<StoredProposal> {
  const entries = await exportWorkspace(deps.docker, deps.settings, contract.run_id);
  const repoDir = path.join(cloneDir, 'repo');
  mirrorWorkspace(repoDir, entries);
  const proposal = await computeProposal(repoDir, path.join(cloneDir, 'home'), contract.base_sha, {
    timeoutMs: deps.settings.git.timeoutMs,
    maxPatchBytes: deps.settings.workspaceMaxBytes,
  });
  const stored = await deps.evidence.put(
    contract.tenant_id,
    `${contract.intent_id}/${contract.run_id}.patch`,
    proposal.patch,
    'text/x-diff',
  );
  const scope = deps.db.forTenant(parseTenantId(contract.tenant_id));
  await scope.transaction(async (tx) => {
    await tx.evidenceItems.record({
      intentId: contract.intent_id,
      runId: contract.run_id,
      kind: 'proposal',
      storageUri: stored.uri,
      sha256: stored.sha256,
      sizeBytes: stored.sizeBytes,
    });
    await tx.runEvents.append(contract.run_id, 'proposal_stored', {
      sha256: stored.sha256,
      size_bytes: stored.sizeBytes,
      changed_files: proposal.changedFiles.length,
    });
  });
  return { ...stored, changedFiles: proposal.changedFiles.length };
}
