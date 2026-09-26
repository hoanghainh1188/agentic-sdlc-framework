// GitHub implementation of `GitHostAdapter` (design/D-03 section 7.1, D-08 B05, ADR-M23).
import type {
  Approval,
  CheckItem,
  CheckSummary,
  EventCursor,
  GitEvent,
  GitHostAdapter,
  PullRequestInfo,
  RepoRef,
  ShortLivedToken,
  TokenScope,
} from '@sdlc/contracts';
import { GitHostError } from '@sdlc/contracts';

import { AppAuth, checkScope } from './app-auth.js';
import { GitHubHttp } from './http.js';
import {
  actor,
  arr,
  bool,
  checkNumber,
  checkRepo,
  int,
  isSha,
  obj,
  optStr,
  repoPath,
  sha,
  str,
  time,
  url,
} from './json.js';
import { checkRunItem, reviewEvent, statusItem } from './mapping.js';
import { resolveOptions, type GitHubAdapterOptions, type ResolvedOptions } from './options.js';
import { listPages } from './pages.js';
import { Poller } from './polling.js';
import { SecretString } from './secret-string.js';
import { verifyWebhookRequest } from './webhook.js';

/** GitHub limits: comment bodies (characters) and files listed for one pull request. */
export const MAX_COMMENT_CHARS = 65_536;
export const MAX_PULL_REQUEST_FILES = 3000;
const FAILED: ReadonlySet<string> = new Set([
  'failure',
  'error',
  'cancelled',
  'timed_out',
  'action_required',
  'stale',
]);
const LIST_PAGES = 30;

export class GitHubAdapter implements GitHostAdapter {
  readonly #options: ResolvedOptions;
  readonly #http: GitHubHttp;
  readonly #auth: AppAuth;
  readonly #poller: Poller;

  constructor(options: GitHubAdapterOptions) {
    this.#options = resolveOptions(options);
    this.#http = new GitHubHttp(this.#options);
    this.#auth = new AppAuth(this.#options, this.#http);
    this.#poller = new Poller(this.#options, this.#http);
  }

  async createIssueComment(ref: RepoRef, issue: number, body: string): Promise<void> {
    const base = repoPath(ref);
    checkNumber(issue, 'issue');
    if (typeof body !== 'string' || body.trim() === '') {
      throw new GitHostError('invalid_input', { field: 'body' });
    }
    if (body.length > MAX_COMMENT_CHARS) {
      throw new GitHostError('body_too_large', { max_chars: MAX_COMMENT_CHARS });
    }
    await this.#auth.withRepoAuth(ref, (auth) =>
      this.#http.json('POST', `${base}/issues/${issue}/comments`, { auth, body: { body } }),
    );
  }

  async getPullRequest(ref: RepoRef, pr: number): Promise<PullRequestInfo> {
    const base = repoPath(ref);
    checkNumber(pr, 'pr');
    const res = await this.#auth.withRepoAuth(ref, (auth) =>
      this.#http.json('GET', `${base}/pulls/${pr}`, { auth }),
    );
    const p = obj(res.body, 'pull');
    const head = obj(p.head, 'pull.head');
    const baseRef = obj(p.base, 'pull.base');
    const state = str(p.state, 'pull.state');
    if (state !== 'open' && state !== 'closed') {
      throw new GitHostError('invalid_response', { field: 'pull.state' });
    }
    const mergedAt = p.merged_at === null ? null : time(p.merged_at, 'pull.merged_at');
    const mergeSha = optStr(p.merge_commit_sha, 'pull.merge_commit_sha');
    return {
      number: int(p.number, 'pull.number'),
      state,
      draft: bool(p.draft ?? false, 'pull.draft'),
      merged: mergedAt !== null,
      mergedAt,
      mergeCommitSha: mergeSha && isSha(mergeSha) ? mergeSha : null,
      headSha: sha(head.sha, 'pull.head.sha'),
      headRef: str(head.ref, 'pull.head.ref'),
      baseRef: str(baseRef.ref, 'pull.base.ref'),
      author: actor(p.user, 'pull.user'),
      changedFiles: int(p.changed_files, 'pull.changed_files'),
      url: url(p.html_url, 'pull.html_url'),
    };
  }

  async getChangedFiles(ref: RepoRef, pr: number): Promise<string[]> {
    const base = repoPath(ref);
    const info = await this.getPullRequest(ref, pr);
    // GitHub lists at most 3000 files. A partial list could hide a change outside the plan (G5),
    // so a bigger pull request fails instead.
    if (info.changedFiles > MAX_PULL_REQUEST_FILES) {
      throw new GitHostError('too_many_files', { max_files: MAX_PULL_REQUEST_FILES });
    }
    const list = await this.#auth.withRepoAuth(ref, (auth) =>
      listPages(this.#http, `${base}/pulls/${pr}/files`, { auth, maxPages: LIST_PAGES }),
    );
    if (list.truncated || list.items.length !== info.changedFiles) {
      throw new GitHostError('invalid_response', { field: 'files' });
    }
    const paths = new Set<string>();
    for (const item of list.items) {
      const f = obj(item, 'file');
      paths.add(str(f.filename, 'file.filename'));
      // A rename changes the old path too.
      const previous = optStr(f.previous_filename, 'file.previous_filename');
      if (previous) paths.add(previous);
    }
    return [...paths].sort();
  }

  async getCheckStatus(ref: RepoRef, commitSha: string): Promise<CheckSummary> {
    const base = repoPath(ref);
    if (!isSha(commitSha)) throw new GitHostError('invalid_input', { field: 'sha' });
    return this.#auth.withRepoAuth(ref, async (auth) => {
      const runs = await listPages(this.#http, `${base}/commits/${commitSha}/check-runs`, {
        auth,
        maxPages: LIST_PAGES,
        query: { filter: 'latest' },
        extract: (body) => arr(obj(body, 'check_runs').check_runs, 'check_runs'),
      });
      if (runs.truncated) throw new GitHostError('invalid_response', { field: 'check_runs' });
      const status = await this.#http.json('GET', `${base}/commits/${commitSha}/status`, {
        auth,
        query: { per_page: 100 },
      });
      const checks: CheckItem[] = [
        ...runs.items.map((run) => toCheckItem(checkRunItem(run))),
        ...arr(obj(status.body, 'status').statuses, 'statuses').map((s) =>
          toCheckItem(statusItem(s)),
        ),
      ];
      return { sha: commitSha, state: summaryState(checks), checks };
    });
  }

  async getApprovals(ref: RepoRef, pr: number): Promise<Approval[]> {
    const base = repoPath(ref);
    checkNumber(pr, 'pr');
    const list = await this.#auth.withRepoAuth(ref, (auth) =>
      listPages(this.#http, `${base}/pulls/${pr}/reviews`, { auth, maxPages: LIST_PAGES }),
    );
    if (list.truncated) throw new GitHostError('invalid_response', { field: 'reviews' });
    const reviews = list.items
      .map((item) => reviewEvent(checkRepo(ref), pr, item, 'polling'))
      .filter((r) => r !== null)
      .sort(
        (a, b) =>
          a.occurredAt.localeCompare(b.occurredAt) || Number(a.reviewId) - Number(b.reviewId),
      );
    // The latest decision of each reviewer counts; a comment does not change it (GitHub rule).
    const latest = new Map<string, (typeof reviews)[number]>();
    for (const review of reviews) {
      if (review.state !== 'commented') latest.set(review.reviewer.id, review);
    }
    return [...latest.values()]
      .filter((r) => r.state === 'approved')
      .map((r) => ({
        reviewId: r.reviewId,
        reviewer: r.reviewer,
        commitSha: r.commitSha,
        submittedAt: r.occurredAt,
        url: r.url,
      }));
  }

  async getFileAtCommit(ref: RepoRef, path: string, commitSha: string): Promise<string> {
    const base = repoPath(ref);
    if (!isSha(commitSha)) throw new GitHostError('invalid_input', { field: 'sha' });
    const encoded = encodeFilePath(path);
    const bytes = await this.#auth.withRepoAuth(ref, (auth) =>
      this.#http.raw(
        `${base}/contents/${encoded}`,
        { auth, query: { ref: commitSha } },
        this.#options.maxFileBytes,
      ),
    );
    try {
      // `ignoreBOM` keeps a byte-order mark, so the text hashes like the stored file.
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new GitHostError('file_not_utf8');
    }
  }

  async issueShortLivedToken(ref: RepoRef, scope: TokenScope): Promise<ShortLivedToken> {
    const repo = checkRepo(ref);
    const minted = await this.#auth.mint(repo, checkScope(scope));
    return {
      token: new SecretString(minted.token),
      expiresAt: minted.expiresAt,
      repo,
      permissions: minted.permissions,
    };
  }

  async listEventsSince(
    ref: RepoRef,
    cursor: EventCursor,
  ): Promise<{ events: GitEvent[]; next: EventCursor }> {
    const repo = checkRepo(ref);
    return this.#auth.withRepoAuth(repo, (auth) => this.#poller.poll(repo, cursor, auth));
  }

  verifyWebhook(headers: Record<string, string>, rawBody: Buffer): GitEvent {
    return verifyWebhookRequest(this.#options.webhookSecret, headers, rawBody);
  }
}

function toCheckItem(item: CheckItem): CheckItem {
  const { source, id, name, completed, conclusion } = item;
  return { source, id, name, completed, conclusion };
}

function summaryState(checks: readonly CheckItem[]): CheckSummary['state'] {
  if (checks.length === 0) return 'none';
  if (checks.some((c) => c.conclusion !== null && FAILED.has(c.conclusion))) return 'failure';
  if (checks.some((c) => !c.completed)) return 'pending';
  return 'success';
}

/** A repository file path for the contents API: relative, no `.` or `..` segments. */
function encodeFilePath(path: string): string {
  if (typeof path !== 'string' || path.length === 0 || path.length > 4096) {
    throw new GitHostError('invalid_input', { field: 'path' });
  }
  const segments = path.split('/');
  if (
    segments.some(
      (s) => s === '' || s === '.' || s === '..' || s.includes('\\') || s.includes('\0'),
    )
  ) {
    throw new GitHostError('invalid_input', { field: 'path' });
  }
  return segments.map(encodeURIComponent).join('/');
}
