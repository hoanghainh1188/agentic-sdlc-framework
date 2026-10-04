// The request for changes a run answers (task E01 PR 2, D-08 E01 AC4, design/ADR-M41 §2.7,
// QUESTIONS #179, #190).
//
// A valid `request_changes` at G7 takes the intent to G4: the next run starts from the pushed
// commit and the agent gets the reviewer's feedback. Which request, and where its text lives, is
// decided from the database only (#179):
//   - the latest G7 `request_changes` bound to the G7 input of the last pushed run (a later push
//     makes another input, so a request is answered once its run pushed: a CI retry after it gets
//     no old feedback);
//   - its receipt (`git_event_receipts`, the review or the comment that recorded it), by its event
//     ID: `github:review:<id>` or `github:comment:<id>`; never "the latest changes_requested
//     review" (anyone can review a public repository);
//   - the person who decided must still be linked to a Git host account; the text must come from
//     that account.
// The worker calls `feedbackSourceFor` in `prepareRun` and re-checks a review on the Git host
// (`checkReviewStillHolds`): a review dismissed or replaced after the move to G4 starts no run.
// The runner calls it again before it reads the text, as the second line.
// Codes and IDs only here: the text is read by the runner, in memory.
import type { GitHostAdapter, GitTokenPermission, ReviewDecision } from '@sdlc/contracts';

import type { Intent } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import type { GitProvider } from '../db/vocabulary.js';
import { g7InputSha256 } from './g7-facts.js';
import { publishState } from './publish-state.js';

/** Where the feedback text of a request for changes lives on the Git host. */
export interface FeedbackSource {
  readonly kind: 'review' | 'comment';
  /** The Git host's review or comment ID (digits). */
  readonly externalId: string;
  /** The `request_changes` gate decision the run answers. */
  readonly decisionId: string;
  /** The platform user who decided. */
  readonly deciderId: string;
  /** That user's linked Git host accounts (numeric IDs): the text's author must be one of them. */
  readonly deciderAccountIds: readonly string[];
  readonly prNumber: number;
  /** The commit the platform pushed and the reviewer reviewed: the next run's base. */
  readonly pushedHead: string;
  /** The token permission the read needs: a review or a pull request comment, or an issue comment. */
  readonly permission: Extract<GitTokenPermission, 'pull_requests' | 'issues'>;
}

/** Why the feedback of a recorded request cannot be used. Codes only (run event, stop reason). */
export type FeedbackUnavailable =
  | 'no_receipt'
  | 'receipt_unknown'
  | 'identity_unlinked'
  | 'review_withdrawn'
  | 'git_host_unavailable';

export type FeedbackLookup =
  | { readonly kind: 'none' }
  | { readonly kind: 'source'; readonly source: FeedbackSource }
  | { readonly kind: 'unavailable'; readonly reason: FeedbackUnavailable };

const RECEIPT_EVENT = /^github:(review|comment):([1-9][0-9]{0,18})$/;

/** The last run of the intent that the platform pushed, with its pushed commit. */
async function lastPushed(
  scope: TenantScope,
  intentId: string,
): Promise<{ readonly runId: string; readonly headSha: string } | null> {
  const runs = await scope.runs.listForIntent(intentId);
  for (const run of [...runs].reverse()) {
    const { pushed } = await publishState(scope, run.id);
    if (pushed) return { runId: run.id, headSha: pushed.headSha };
  }
  return null;
}

/**
 * The request for changes the intent's next run answers (see the header), or `none`. Reads the
 * database only. `unavailable`: a request is in force but its text cannot be used.
 */
export async function feedbackSourceFor(
  scope: TenantScope,
  intent: Pick<Intent, 'id' | 'project_id' | 'pr_number'>,
): Promise<FeedbackLookup> {
  if (intent.pr_number === null) return { kind: 'none' };
  const pushed = await lastPushed(scope, intent.id);
  if (!pushed) return { kind: 'none' };
  const input = await g7InputSha256(
    scope,
    intent.id,
    pushed.runId,
    intent.pr_number,
    pushed.headSha,
  );
  const request = (await scope.gateDecisions.listForIntent(intent.id, 'G7'))
    .filter((d) => d.decision === 'request_changes' && d.input_sha256 === input)
    .at(-1);
  if (!request) return { kind: 'none' };
  // QUESTIONS #190: G7 takes requests for changes from reviews and comments only.
  const receipt = await scope.gitEventReceipts.findByDecision(request.id);
  if (!receipt || request.decided_by === null) return unavailable('no_receipt');
  const match = RECEIPT_EVENT.exec(receipt.event_id);
  if (!match) return unavailable('receipt_unknown');
  const project = await scope.projects.getById(intent.project_id);
  const provider: GitProvider = project?.git_provider ?? 'github';
  const accounts = (await scope.userIdentities.listForUser(request.decided_by))
    .filter((identity) => identity.provider === provider)
    .map((identity) => identity.external_id);
  const user = await scope.users.getById(request.decided_by);
  if (accounts.length === 0 || user?.status !== 'active') return unavailable('identity_unlinked');
  const kind = match[1] === 'review' ? 'review' : 'comment';
  // GitHub reads a pull request comment with `pull_requests: read` and an issue comment with
  // `issues: read` (either works for the endpoint); a review needs `pull_requests: read`.
  const onPullRequest = kind === 'review' || receipt.issue_number === intent.pr_number;
  return {
    kind: 'source',
    source: {
      kind,
      externalId: match[2]!,
      decisionId: request.id,
      deciderId: request.decided_by,
      deciderAccountIds: accounts,
      prNumber: intent.pr_number,
      pushedHead: pushed.headSha,
      permission: onPullRequest ? 'pull_requests' : 'issues',
    },
  };
}

function unavailable(reason: FeedbackUnavailable): FeedbackLookup {
  return { kind: 'unavailable', reason };
}

/**
 * The worker's re-check of a review source on the Git host (Harry, E01 PR 2 plan): the review must
 * still be its reviewer's latest decision, `changes_requested`, of the pushed commit, by the
 * decider's account. A dismissed or replaced review after the move to G4 starts no run. A comment
 * source has nothing to re-check here (the runner re-reads it). Returns null when it holds.
 */
export function reviewStillHolds(
  source: FeedbackSource,
  reviews: readonly ReviewDecision[],
): FeedbackUnavailable | null {
  if (source.kind !== 'review') return null;
  const review = reviews.find((r) => r.eventId === `github:review:${source.externalId}`);
  if (
    review?.state !== 'changes_requested' ||
    review.commitSha !== source.pushedHead ||
    review.reviewer.type !== 'user' ||
    !source.deciderAccountIds.includes(review.reviewer.id)
  ) {
    return 'review_withdrawn';
  }
  return null;
}

/** What `prepareRun` reads on the Git host for the re-check (before the intent lock). */
export type FeedbackGitHost = Pick<GitHostAdapter, 'getReviews'>;
