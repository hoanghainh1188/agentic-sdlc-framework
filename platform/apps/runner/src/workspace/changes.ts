// The changes of a run, computed and checked outside the sandbox at the end of the run (task C07,
// D-08 C07 AC1, QUESTIONS #130 A, #126, design/ADR-M34 §2.2–§2.4).
//
// 1. `computeRunPatch` (export.ts): the sandbox's workspace mirrored onto the runner's clone, the
//    full diff against `base_sha` with hardened git. Committed and uncommitted edits alike: what the
//    agent left is what G5 judges, and a stopped run's edits are kept as evidence.
// 2. The diff is stored as evidence `diff` (`s3://evidence/diffs/<tenant>/<intent>/<run>.patch`,
//    never overwritten) with an `evidence_items` row and the run event `diff_stored`.
// 3. The changed paths are checked: against the plan (`PolicyEngine.checkScope` with the contract's
//    `planned_files`) and against the paths the agent reads as instructions
//    (`isAgentInstructionPath`, the pinned file included: editing it changes the agent). The run
//    event `changes_checked` holds counts and the SHA-256 of the sorted paths, never a path.
// G5 (PR 2) decides from `changes_checked`; the runner only records. Any failure throws: the caller
// fails the run (`agent_changes_unavailable`), so no run reaches G5 without its checked changes.
import crypto from 'node:crypto';

import {
  isAgentInstructionPath,
  type EvidenceStore,
  type PolicyEngine,
  type RunContract,
} from '@sdlc/contracts';
import { parseTenantId, type PlatformDatabase } from '@sdlc/core';

import type { DockerClient } from '../docker/client.js';
import type { RunnerSettings } from '../settings.js';
import { computeRunPatch } from './export.js';

export interface ChangesDeps {
  readonly db: PlatformDatabase;
  readonly docker: DockerClient;
  readonly settings: RunnerSettings;
  /** The evidence store of diffs (key prefix `diffs/`). */
  readonly evidence: EvidenceStore;
  /** The scope check of the project's policy engine. */
  readonly policy: Pick<PolicyEngine, 'checkScope'>;
}

export interface CheckedChanges {
  readonly changedFiles: number;
  readonly outOfScope: number;
  readonly instructionFiles: number;
  /** SHA-256 of the RFC 8785 JSON of the sorted changed paths (an array of strings). */
  readonly pathsSha256: string;
  readonly diffSha256: string;
}

/** Counts of the changed paths; the paths stay in memory. */
export function checkChangedPaths(
  policy: Pick<PolicyEngine, 'checkScope'>,
  plannedFiles: readonly string[],
  changedFiles: readonly string[],
): Omit<CheckedChanges, 'diffSha256'> {
  const sorted = [...changedFiles].sort();
  const scope = policy.checkScope({ plannedFiles, changedFiles: sorted });
  return {
    changedFiles: sorted.length,
    outOfScope: scope.outOfScope.length,
    instructionFiles: sorted.filter(isAgentInstructionPath).length,
    // For an array of strings, RFC 8785 is exactly JSON.stringify.
    pathsSha256: crypto.createHash('sha256').update(JSON.stringify(sorted), 'utf8').digest('hex'),
  };
}

/** Computes, stores and checks the run's changes (see the header). */
export async function storeChanges(
  deps: ChangesDeps,
  contract: RunContract,
  cloneDir: string,
): Promise<CheckedChanges> {
  const patch = await computeRunPatch(deps, contract, cloneDir);
  const checked = checkChangedPaths(deps.policy, contract.planned_files, patch.changedFiles);
  const stored = await deps.evidence.put(
    contract.tenant_id,
    `${contract.intent_id}/${contract.run_id}.patch`,
    patch.patch,
    'text/x-diff',
  );
  const scope = deps.db.forTenant(parseTenantId(contract.tenant_id));
  await scope.transaction(async (tx) => {
    await tx.evidenceItems.record({
      intentId: contract.intent_id,
      runId: contract.run_id,
      kind: 'diff',
      storageUri: stored.uri,
      sha256: stored.sha256,
      sizeBytes: stored.sizeBytes,
    });
    await tx.runEvents.append(contract.run_id, 'diff_stored', {
      sha256: stored.sha256,
      size_bytes: stored.sizeBytes,
      changed_files: checked.changedFiles,
    });
    await tx.runEvents.append(contract.run_id, 'changes_checked', {
      changed_files: checked.changedFiles,
      out_of_scope: checked.outOfScope,
      instruction_files: checked.instructionFiles,
      paths_sha256: checked.pathsSha256,
    });
  });
  return { ...checked, diffSha256: stored.sha256 };
}
