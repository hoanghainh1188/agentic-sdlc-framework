// What G8 decides on (task E03, D-08 E03 AC1, D-02 FR-11, FR-17, design/ADR-M49 §2.2–§2.3).
//
// The G8 input binds every G8 decision and escalation (FR-17, handbook Ch.15 §15.4: "approvals are
// bound to the exact version … artifact digest for G8"): the merged run, its pull request, the
// pushed head and the merge commit (run event `pr_merged`), and the release hash of the intent's
// latest Evidence Pack (`evidence_packs.release_sha256`: the pack's content without the G8 parts).
// It is computed from the database alone, so `/approve G8` needs no evidence store.
// - Any change of the evidence before G8 (an item, an escalation, CI, cost, the AI record's
//   disclosure facts) makes a new release hash, so a new input: earlier G8 approvals are voided.
// - A new G8 decision makes a new pack version with the same release hash: the input stays.
import { createHash } from 'node:crypto';

import { canonicalJson } from '@sdlc/config';

import type { EvidencePack, Intent, Run } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { g7Producers } from './g7-facts.js';
import { lastPushedRun } from './publish-state.js';

/** The merge G7 recorded (`pr_merged`): what G8 releases. */
export interface G8Merge {
  readonly run: Run;
  readonly prNumber: number;
  readonly headSha: string;
  readonly mergeCommitSha: string | null;
}

/** The merge of the intent's last pushed run, or null when G7 recorded none. */
export async function gatherG8Merge(scope: TenantScope, intent: Intent): Promise<G8Merge | null> {
  const run = await lastPushedRun(scope, intent.id);
  if (!run) return null;
  const merged = (await scope.runEvents.list(run.id))
    .filter((e) => e.event_type === 'pr_merged')
    .at(-1)?.payload;
  if (typeof merged?.head_sha !== 'string' || typeof merged.pr_number !== 'number') return null;
  return {
    run,
    prNumber: merged.pr_number,
    headSha: merged.head_sha,
    mergeCommitSha: typeof merged.merge_commit_sha === 'string' ? merged.merge_commit_sha : null,
  };
}

/**
 * The G8 input hash (ADR-M49 §2.3). `releaseSha256` null: no pack could be built (the refusal for
 * a missing AI record is bound to the merge alone).
 */
export function g8InputSha256(merge: G8Merge, releaseSha256: string | null): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        v: 1,
        run_id: merge.run.id,
        pr_number: merge.prNumber,
        head_sha: merge.headSha,
        merge_commit_sha: merge.mergeCommitSha,
        release_sha256: releaseSha256,
      }),
      'utf8',
    )
    .digest('hex');
}

export interface G8Facts {
  readonly merge: G8Merge;
  /** The intent's latest pack with a release hash. */
  readonly pack: EvidencePack & { readonly release_sha256: string };
  readonly inputSha256: string;
}

/** The G8 facts from the database, or null before the merge or before a pack with a release hash. */
export async function gatherG8Facts(scope: TenantScope, intent: Intent): Promise<G8Facts | null> {
  const merge = await gatherG8Merge(scope, intent);
  const pack = await scope.evidencePacks.latest(intent.id);
  if (!merge || !pack || pack.release_sha256 === null) return null;
  const withHash = pack as EvidencePack & { readonly release_sha256: string };
  return { merge, pack: withHash, inputSha256: g8InputSha256(merge, withHash.release_sha256) };
}

/**
 * The producers of the release (FR-11): the producers of the change G7 merged (the intent's
 * creator, the people who allowed its runs, the plan submitters). They never decide G8.
 */
export function g8Producers(scope: TenantScope, intent: Intent): Promise<string[]> {
  return g7Producers(scope, intent);
}
