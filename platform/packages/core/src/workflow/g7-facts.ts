// What G7 reads and decides on (task E01, D-08 E01 AC1–AC5, design/ADR-M41 §2.2–§2.3,
// QUESTIONS #175–#177).
//
// `readG7` runs before the step's transaction (no HTTP call under the intent lock, as at G4 and
// G6): the run's pull request (state, head, merge commit, who merged it), the latest review
// decision of each reviewer, and the accounts that authored its commits. The step records it as
// the run event `g7_checked` when it changed (codes, counts and hashes only: logins and review
// texts stay on the Git host) and records the reviews as gate decisions.
//
// The G7 input binds every G7 decision and escalation (FR-17): the run, its pull request, the
// commit the platform pushed and the change flags of the plan G3 approved (dual approval, FR-16).
// A new push makes another run (a request for changes, PR 2), so another input: earlier approvals
// no longer count.
import { createHash } from 'node:crypto';

import { canonicalJson } from '@sdlc/config';
import type {
  CommitAuthors,
  GitActor,
  GitHostAdapter,
  PullRequestInfo,
  ReviewDecision,
} from '@sdlc/contracts';

import type { Intent, Run } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { projectRepoRef } from './g4-proposal.js';
import { latestRun, publishState } from './publish-state.js';

/** What G7 reads outside the database (the worker wires the Git host in; tests pass fakes). */
export interface G7Deps {
  readonly gitHost: Pick<GitHostAdapter, 'getPullRequest' | 'getReviews' | 'getCommitAuthors'>;
}

export type G7PrState = 'open' | 'closed' | 'merged';

export interface G7Reading {
  readonly runId: string;
  readonly prNumber: number;
  readonly prState: G7PrState;
  readonly headSha: string;
  readonly mergeCommitSha: string | null;
  /** ISO 8601 UTC, when merged. Reviews submitted later are late (QUESTIONS #177). */
  readonly mergedAt: string | null;
  readonly mergedBy: GitActor | null;
  readonly reviews: readonly ReviewDecision[];
  readonly authors: CommitAuthors;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function stateOf(pr: PullRequestInfo): G7PrState {
  if (pr.merged) return 'merged';
  return pr.state;
}

/**
 * Reads the run's pull request, its reviews and its commit authors. Null when the intent has no
 * pushed run with a linked pull request. Throws `GitHostError` when the Git host cannot be read.
 */
export async function readG7(
  scope: TenantScope,
  deps: G7Deps,
  intent: Intent,
): Promise<G7Reading | null> {
  const run = await latestRun(scope, intent.id);
  if (!run || intent.pr_number === null) return null;
  const { pushed } = await publishState(scope, run.id);
  const project = await scope.projects.getById(intent.project_id);
  const ref = project ? projectRepoRef(project) : undefined;
  if (!pushed || !ref) return null;
  const pr = await deps.gitHost.getPullRequest(ref, intent.pr_number);
  const reviews = await deps.gitHost.getReviews(ref, pr.number);
  const authors = await deps.gitHost.getCommitAuthors(ref, pr.number);
  return {
    runId: run.id,
    prNumber: pr.number,
    prState: stateOf(pr),
    headSha: pr.headSha,
    mergeCommitSha: pr.merged ? pr.mergeCommitSha : null,
    mergedAt: pr.merged ? pr.mergedAt : null,
    mergedBy: pr.merged ? pr.mergedBy : null,
    reviews,
    authors,
  };
}

/** The SHA-256 of the review decisions: IDs, states and commits, sorted (never logins). */
export function reviewsSha256(reviews: readonly ReviewDecision[]): string {
  return sha256(
    reviews
      .map((r) => [r.reviewId, r.state, r.commitSha])
      .sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0)),
  );
}

/** Who merged the pull request, as G7 sees it (ADR-M41 §2.5). Never the account itself. */
export type G7Merger = 'person' | 'producer' | 'bot' | 'unknown';

/** Records the reading as `g7_checked` when it differs from the run's last one. Under the lock. */
export async function recordG7Reading(
  tx: TenantScope,
  reading: G7Reading,
  merger: G7Merger | null,
): Promise<boolean> {
  const onHead = reading.reviews.filter((r) => r.commitSha === reading.headSha);
  const next = {
    pr_number: reading.prNumber,
    pr_state: reading.prState,
    head_sha: reading.headSha,
    ...(reading.mergeCommitSha ? { merge_commit_sha: reading.mergeCommitSha } : {}),
    ...(merger ? { merger } : {}),
    reviews_sha256: reviewsSha256(reading.reviews),
    approvals: onHead.filter((r) => r.state === 'approved').length,
    changes_requested: onHead.filter((r) => r.state === 'changes_requested').length,
    commit_authors: reading.authors.accounts.length,
    commits_without_account: reading.authors.withoutAccount,
  };
  const last = (await tx.runEvents.list(reading.runId))
    .filter((e) => e.event_type === 'g7_checked')
    .at(-1)?.payload;
  if (last && canonicalJson(last) === canonicalJson(next)) return false;
  await tx.runEvents.append(reading.runId, 'g7_checked', next);
  return true;
}

export interface G7Facts {
  readonly run: Run;
  /** The commit the platform pushed: the head that may be approved and merged. */
  readonly pushedHead: string;
  readonly prNumber: number;
  /** The G7 input hash: approvals, decisions and escalations are bound to it. */
  readonly inputSha256: string;
}

/** The G7 facts of the intent's last run from the database, or null before its pull request. */
export async function gatherG7Facts(scope: TenantScope, intent: Intent): Promise<G7Facts | null> {
  const run = await latestRun(scope, intent.id);
  if (run?.status !== 'succeeded' || intent.pr_number === null) return null;
  const pushed = (await scope.runEvents.list(run.id))
    .filter((e) => e.event_type === 'branch_pushed')
    .at(-1);
  if (!pushed || typeof pushed.payload.head_sha !== 'string') return null;
  const pushedHead = pushed.payload.head_sha;
  return {
    run,
    pushedHead,
    prNumber: intent.pr_number,
    inputSha256: await g7InputSha256(scope, intent.id, run.id, intent.pr_number, pushedHead),
  };
}

/**
 * The G7 input hash of a pushed run (ADR-M41 §2.3): the run, its pull request, the pushed commit
 * and the change flags of the plan. Also used after G7 (E01 PR 2, `g7-feedback.ts`): a request for
 * changes bound to the last pushed run's input is the one the next run answers.
 */
export async function g7InputSha256(
  scope: TenantScope,
  intentId: string,
  runId: string,
  prNumber: number,
  pushedHead: string,
): Promise<string> {
  const flags = [...((await scope.plans.latest(intentId))?.change_flags ?? [])].sort();
  return sha256({
    v: 1,
    run_id: runId,
    pr_number: prNumber,
    head_sha: pushedHead,
    change_flags: flags,
  });
}

/**
 * The producers of the change under review at G7 (FR-11, AC2): the intent's creator (QUESTIONS
 * #16), the person who allowed each of its runs (`triggered_by`), the people who submitted its
 * plan files (B09), and the platform users who authored a commit of the pull request (mapped by
 * numeric account ID, when G7 read them). Agents and bots are never people, so never approvers.
 */
export async function g7Producers(
  scope: TenantScope,
  intent: Intent,
  commitAuthorUsers: readonly string[] = [],
): Promise<string[]> {
  const runs = await scope.runs.listForIntent(intent.id);
  const plans = await scope.plans.list(intent.id);
  return [
    ...new Set([
      intent.created_by,
      ...runs.map((r) => r.triggered_by),
      ...plans.map((p) => p.submitted_by),
      ...commitAuthorUsers,
    ]),
  ].filter((id): id is string => typeof id === 'string');
}
