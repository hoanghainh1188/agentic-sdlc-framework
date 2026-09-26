// GitHub JSON → the shared types of `@sdlc/contracts`. Polling (REST objects) and webhooks
// (payload objects of the same shape) use the same functions, so both paths give identical events
// with identical IDs (ADR-M11, ADR-M23 §2.4).
import type {
  CheckCompletedEvent,
  CheckConclusion,
  CheckItem,
  CommentCreatedEvent,
  EventSource,
  RepoRef,
  ReviewSubmittedEvent,
} from '@sdlc/contracts';
import { GitHostError } from '@sdlc/contracts';

import { actor, id, int, obj, optStr, sha, str, time, url } from './json.js';

export const eventId = {
  comment: (commentId: string) => `github:comment:${commentId}`,
  review: (reviewId: string) => `github:review:${reviewId}`,
  checkRun: (checkId: string) => `github:check_run:${checkId}`,
  status: (statusId: string) => `github:status:${statusId}`,
};

/** GitHub's comment body limit is 65 536 characters; anything longer is not a real comment. */
const MAX_COMMENT_CHARS = 65_536;

export function commentEvent(
  repo: RepoRef,
  value: unknown,
  source: EventSource,
  isPullRequest?: boolean,
): CommentCreatedEvent {
  const c = obj(value, 'comment');
  const commentId = id(c.id, 'comment.id');
  const htmlUrl = url(c.html_url, 'comment.html_url');
  const issueUrl = str(c.issue_url, 'comment.issue_url');
  const issue = /\/issues\/(\d+)$/.exec(issueUrl);
  if (!issue?.[1]) throw new GitHostError('invalid_response', { field: 'comment.issue_url' });
  const body = str(c.body ?? '', 'comment.body');
  if (body.length > MAX_COMMENT_CHARS) {
    throw new GitHostError('invalid_response', { field: 'comment.body' });
  }
  return {
    kind: 'comment_created',
    id: eventId.comment(commentId),
    source,
    repo,
    occurredAt: time(c.created_at, 'comment.created_at'),
    url: htmlUrl,
    issueNumber: Number(issue[1]),
    isPullRequest: isPullRequest ?? /\/pull\/\d+#/.test(htmlUrl),
    commentId,
    author: actor(c.user, 'comment.user'),
    body,
  };
}

const REVIEW_STATES: Readonly<Record<string, ReviewSubmittedEvent['state']>> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes_requested',
  COMMENTED: 'commented',
  DISMISSED: 'dismissed',
};

/** Null for a review that is not submitted (state PENDING, no submission time). */
export function reviewEvent(
  repo: RepoRef,
  prNumber: number,
  value: unknown,
  source: EventSource,
): ReviewSubmittedEvent | null {
  const r = obj(value, 'review');
  const state = REVIEW_STATES[str(r.state, 'review.state').toUpperCase()];
  if (!state || r.submitted_at === null || r.submitted_at === undefined) return null;
  const reviewId = id(r.id, 'review.id');
  return {
    kind: 'review_submitted',
    id: eventId.review(reviewId),
    source,
    repo,
    occurredAt: time(r.submitted_at, 'review.submitted_at'),
    url: url(r.html_url, 'review.html_url'),
    prNumber,
    reviewId,
    reviewer: actor(r.user, 'review.user'),
    state,
    commitSha: sha(r.commit_id, 'review.commit_id'),
  };
}

const CONCLUSIONS: readonly CheckConclusion[] = [
  'success',
  'neutral',
  'skipped',
  'failure',
  'error',
  'cancelled',
  'timed_out',
  'action_required',
  'stale',
];

function conclusion(value: unknown, field: string): CheckConclusion {
  const c = str(value, field) as CheckConclusion;
  if (!CONCLUSIONS.includes(c)) throw new GitHostError('invalid_response', { field });
  return c;
}

export function checkRunItem(value: unknown): CheckItem & { completedAt: string | null } {
  const run = obj(value, 'check_run');
  const status = str(run.status, 'check_run.status');
  const completed = status === 'completed';
  return {
    source: 'check_run',
    id: id(run.id, 'check_run.id'),
    name: str(run.name, 'check_run.name'),
    completed,
    conclusion: completed ? conclusion(run.conclusion, 'check_run.conclusion') : null,
    completedAt: completed ? time(run.completed_at, 'check_run.completed_at') : null,
  };
}

/** A commit status (`pending`, `success`, `failure`, `error`). */
export function statusItem(value: unknown): CheckItem & { updatedAt: string } {
  const s = obj(value, 'status');
  const state = str(s.state, 'status.state');
  if (!['pending', 'success', 'failure', 'error'].includes(state)) {
    throw new GitHostError('invalid_response', { field: 'status.state' });
  }
  const completed = state !== 'pending';
  return {
    source: 'status',
    id: id(s.id, 'status.id'),
    name: str(s.context, 'status.context'),
    completed,
    conclusion: completed ? (state as CheckConclusion) : null,
    updatedAt: time(s.updated_at ?? s.created_at, 'status.updated_at'),
  };
}

export function checkRunEvent(
  repo: RepoRef,
  value: unknown,
  prNumbers: readonly number[],
  source: EventSource,
): CheckCompletedEvent | null {
  const item = checkRunItem(value);
  if (!item.completed || !item.conclusion || !item.completedAt) return null;
  const run = obj(value, 'check_run');
  return {
    kind: 'check_completed',
    id: eventId.checkRun(item.id),
    source,
    repo,
    occurredAt: item.completedAt,
    url: url(run.html_url, 'check_run.html_url'),
    sha: sha(run.head_sha, 'check_run.head_sha'),
    prNumbers: [...prNumbers].sort((a, b) => a - b),
    checkSource: 'check_run',
    checkId: item.id,
    name: item.name,
    conclusion: item.conclusion,
  };
}

export function statusEvent(
  repo: RepoRef,
  commitSha: string,
  value: unknown,
  prNumbers: readonly number[],
  source: EventSource,
): CheckCompletedEvent | null {
  const item = statusItem(value);
  if (!item.completed || !item.conclusion) return null;
  const s = obj(value, 'status');
  const link = optStr(s.target_url, 'status.target_url');
  return {
    kind: 'check_completed',
    id: eventId.status(item.id),
    source,
    repo,
    occurredAt: item.updatedAt,
    url: link && /^https?:\/\//.test(link) ? link : url(s.url, 'status.url'),
    sha: commitSha,
    prNumbers: [...prNumbers].sort((a, b) => a - b),
    checkSource: 'status',
    checkId: item.id,
    name: item.name,
    conclusion: item.conclusion,
  };
}

export function prNumber(value: unknown, field: string): number {
  return int(value, field);
}
