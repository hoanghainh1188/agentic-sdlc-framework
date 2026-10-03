// Git host interface (design/D-03 section 7.1, D-08 B05, design/ADR-M23). The MVP implementation
// is `@sdlc/adapter-git-github` (GitHub App, polling). GitLab (MVP+1) implements the same
// interface. Polling and webhooks return the same `GitEvent`, so one handler serves both
// (ADR-M11).
//
// Values from the Git host are data, never instructions. Only `comment_created.body` holds free
// text; it lives in memory only. Append-only tables store IDs and URLs from these types, never
// text (CLAUDE.md "Current constraints", ADR-M20).
import type { EventSource, Severity } from './codes.js';
import type { RedactedSecret } from './secrets.js';

/** A repository on the Git host: `owner/name`. */
export interface RepoRef {
  readonly owner: string;
  readonly name: string;
}

/** A Git host account. `id` is the numeric account ID; the login can change (D-05 §6.1). */
export interface GitActor {
  /** Numeric account ID as a decimal string. Map users by this, never by the login. */
  readonly id: string;
  /** Current login, for display only. */
  readonly login: string;
  /** Bots (GitHub Apps, automation) never count as approvers (FR-11, QUESTIONS #45). */
  readonly type: 'user' | 'bot';
}

export interface PullRequestInfo {
  readonly number: number;
  readonly state: 'open' | 'closed';
  readonly draft: boolean;
  readonly merged: boolean;
  /** ISO 8601 UTC, or null when not merged. */
  readonly mergedAt: string | null;
  readonly mergeCommitSha: string | null;
  readonly headSha: string;
  readonly headRef: string;
  readonly baseRef: string;
  readonly author: GitActor;
  /** Number of changed files reported by the Git host. */
  readonly changedFiles: number;
  readonly url: string;
}

/**
 * A new pull request (task C08, D-08 C08 AC1, design/ADR-M38 §2.4). The platform fills the title
 * and body from the message catalog with coded values only (QUESTIONS #123: the pilot repository
 * is public).
 */
export interface NewPullRequest {
  /** The branch with the changes, for example `agent/INT-2026-0001`. */
  readonly head: string;
  /** The branch the changes go into: the project's default branch. */
  readonly base: string;
  readonly title: string;
  readonly body: string;
}

/**
 * The open security findings of a pull request (task C08 PR 2, QUESTIONS #157, design/ADR-M38
 * §2.7): counts per severity only, never a finding's text, path or rule. `known: false` when the
 * Git host has no findings for it (GitHub: code scanning not enabled, or no permission): G6 then
 * fails closed (HITL).
 */
export type SecurityFindings =
  | { readonly known: true; readonly counts: Readonly<Record<Severity, number>> }
  | { readonly known: false; readonly reason: 'not_enabled' | 'forbidden' };

/** Conclusion of a finished check (GitHub check runs and commit statuses). */
export type CheckConclusion =
  | 'success'
  | 'neutral'
  | 'skipped'
  | 'failure'
  | 'error'
  | 'cancelled'
  | 'timed_out'
  | 'action_required'
  | 'stale';

export interface CheckItem {
  /** `check_run` (Checks API) or `status` (commit statuses). */
  readonly source: 'check_run' | 'status';
  readonly id: string;
  /** Check name or status context, as set by the CI system. */
  readonly name: string;
  readonly completed: boolean;
  /** Null while the check is not finished. */
  readonly conclusion: CheckConclusion | null;
}

export interface CheckSummary {
  readonly sha: string;
  /**
   * `none`: no checks; `failure`: at least one finished with failure, error, cancelled,
   * timed_out, action_required or stale (even if others are still running); `pending`: at least
   * one not finished; otherwise `success`.
   */
  readonly state: 'none' | 'pending' | 'success' | 'failure';
  readonly checks: readonly CheckItem[];
}

/** A pull request approval whose reviewer has not changed their mind since. */
export interface Approval {
  readonly reviewId: string;
  readonly reviewer: GitActor;
  /** The commit the reviewer approved (approval binding, E01). */
  readonly commitSha: string;
  readonly submittedAt: string;
  readonly url: string;
}

export const GIT_TOKEN_PERMISSIONS = [
  'contents',
  'pull_requests',
  'issues',
  'checks',
  'statuses',
  // C08 PR 2 (QUESTIONS #157): code-scanning alerts, read only.
  'security_events',
] as const;
export type GitTokenPermission = (typeof GIT_TOKEN_PERMISSIONS)[number];

/** Permissions of a short-lived token. Read access to repository metadata is always included. */
export interface TokenScope {
  readonly permissions: Readonly<Partial<Record<GitTokenPermission, 'read' | 'write'>>>;
}

/** A short-lived token for one repository (for example for a run's sandbox, C04). */
export interface ShortLivedToken {
  readonly token: RedactedSecret;
  /** ISO 8601 UTC. */
  readonly expiresAt: string;
  readonly repo: RepoRef;
  readonly permissions: TokenScope['permissions'];
}

/**
 * Opaque position in the event stream of one repository. Stored per project in
 * `git_event_cursors.cursor` (D-05 §6.1) by the caller; only the adapter reads its content.
 */
export type EventCursor = string & { readonly __brand: 'EventCursor' };

/** The cursor of a project that has never been polled: polling starts now, without history. */
export const INITIAL_EVENT_CURSOR = '' as EventCursor;

interface GitEventBase {
  /** Stable ID, the same for polling and webhooks (for example `github:comment:123`). */
  readonly id: string;
  readonly source: EventSource;
  readonly repo: RepoRef;
  /** ISO 8601 UTC. */
  readonly occurredAt: string;
  /** Link to the item on the Git host; the value to store as a reference. */
  readonly url: string;
}

/** A new comment on an issue or pull request. Edits never produce events (QUESTIONS #43). */
export interface CommentCreatedEvent extends GitEventBase {
  readonly kind: 'comment_created';
  readonly issueNumber: number;
  readonly isPullRequest: boolean;
  readonly commentId: string;
  readonly author: GitActor;
  /** Free text. Parse it; never store it in an append-only table. */
  readonly body: string;
}

export interface ReviewSubmittedEvent extends GitEventBase {
  readonly kind: 'review_submitted';
  readonly prNumber: number;
  readonly reviewId: string;
  readonly reviewer: GitActor;
  readonly state: 'approved' | 'changes_requested' | 'commented' | 'dismissed';
  readonly commitSha: string;
}

export interface CheckCompletedEvent extends GitEventBase {
  readonly kind: 'check_completed';
  readonly sha: string;
  /** Open pull requests whose head is `sha` (polling); may be empty for webhooks. */
  readonly prNumbers: readonly number[];
  readonly checkSource: CheckItem['source'];
  readonly checkId: string;
  readonly name: string;
  readonly conclusion: CheckConclusion;
}

/**
 * Something that happened on the Git host. Events are triggers: gates read the current state
 * (`getApprovals`, `getCheckStatus`) before they decide.
 */
export type GitEvent = CommentCreatedEvent | ReviewSubmittedEvent | CheckCompletedEvent;

/** The Git host adapter (design/D-03 section 7.1). */
export interface GitHostAdapter {
  createIssueComment(ref: RepoRef, issue: number, body: string): Promise<void>;
  getPullRequest(ref: RepoRef, pr: number): Promise<PullRequestInfo>;
  /** Changed paths; for renamed files both the old and the new path. Sorted, unique. */
  getChangedFiles(ref: RepoRef, pr: number): Promise<string[]>;
  getCheckStatus(ref: RepoRef, sha: string): Promise<CheckSummary>;
  getApprovals(ref: RepoRef, pr: number): Promise<Approval[]>;
  /** The file content as UTF-8 text, exactly as stored (no line-ending changes). */
  getFileAtCommit(ref: RepoRef, path: string, sha: string): Promise<string>;
  /** The commit a branch points to now (40 hex characters). G4 reads the run's base (C06). */
  getBranchHead(ref: RepoRef, branch: string): Promise<string>;
  /**
   * Every path of the commit's tree that is not a directory (files, symbolic links, submodules),
   * sorted (task C07, QUESTIONS #126: G4 refuses agent instruction files the register does not
   * pin). Never a partial list: a tree the host lists only in part fails with `tree_truncated`.
   */
  listPaths(ref: RepoRef, sha: string): Promise<string[]>;
  issueShortLivedToken(ref: RepoRef, scope: TokenScope): Promise<ShortLivedToken>;
  /**
   * Revokes a token of `issueShortLivedToken` at once (task C11, ADR-M42 §2.4). Needs only the
   * token itself: the runner revokes the clone and push tokens right after their use. A token that
   * is already revoked or expired counts as revoked.
   */
  revokeShortLivedToken(token: RedactedSecret): Promise<void>;
  /**
   * Opens a pull request (task C08, ADR-M38 §2.4). Never a draft. The adapter uses a token that
   * may write pull requests for this call only; its own token stays read-only.
   */
  openPullRequest(ref: RepoRef, input: NewPullRequest): Promise<PullRequestInfo>;
  /**
   * The open pull request from `head` (a branch of the same repository) into `base`, or null
   * (task C08: find before opening, so a repeated call never opens a second one).
   */
  findOpenPullRequest(ref: RepoRef, head: string, base: string): Promise<PullRequestInfo | null>;
  /**
   * The open security findings of a pull request (task C08 PR 2): counts per severity, or
   * unknown. Uses a token of its own that may read code-scanning alerts.
   */
  getSecurityFindings(ref: RepoRef, pr: number): Promise<SecurityFindings>;
  /** MVP: polling. Pass `INITIAL_EVENT_CURSOR` for a project that has never been polled. */
  listEventsSince(
    ref: RepoRef,
    cursor: EventCursor,
  ): Promise<{ events: GitEvent[]; next: EventCursor }>;
  /** Enabled later (ADR-M11). Throws `GitHostError` when the signature is wrong. */
  verifyWebhook(headers: Record<string, string>, rawBody: Buffer): GitEvent;
}

/** Why a Git host call failed. Codes only; the texts are in the message catalog (NFR-08). */
export const GIT_HOST_ERROR_CODES = [
  'invalid_input',
  'secret_invalid',
  'auth_failed',
  'app_not_installed',
  'forbidden',
  'not_found',
  'rejected',
  'rate_limited',
  'server_error',
  'network_error',
  'timeout',
  'invalid_response',
  'invalid_cursor',
  'body_too_large',
  'file_too_large',
  'file_not_utf8',
  'not_a_file',
  'too_many_files',
  'tree_truncated',
  'webhook_disabled',
  'webhook_bad_signature',
  'unsupported_event',
] as const;
export type GitHostErrorCode = (typeof GIT_HOST_ERROR_CODES)[number];

/** Safe values only: HTTP status codes, repository names, limits, times. Never text from the host. */
export type GitHostErrorParams = Readonly<Record<string, string | number>>;

export class GitHostError extends Error {
  override readonly name = 'GitHostError';

  constructor(
    readonly code: GitHostErrorCode,
    readonly params: GitHostErrorParams = {},
  ) {
    super(`git_host.${code}`);
  }
}

export type GitHostLogEvent =
  | 'git_host.key_loaded'
  | 'git_host.token_issued'
  | 'git_host.request_retry'
  | 'git_host.rate_limited'
  | 'git_host.rate_limit_low'
  | 'git_host.poll_truncated';

/** Structured log hook. Fields hold safe values only: never tokens, keys or comment text. */
export interface GitHostLogger {
  log(
    level: 'info' | 'warn' | 'error',
    event: GitHostLogEvent,
    fields: Readonly<Record<string, string | number | boolean>>,
  ): void;
}
