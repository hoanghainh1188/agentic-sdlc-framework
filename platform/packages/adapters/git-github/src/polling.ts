// Reading events by polling (D-08 B05 AC2, D-02 FR-21, ADR-M11, design/ADR-M23 §2.3).
//
// | Events   | GitHub endpoints                                                                  |
// |----------|-----------------------------------------------------------------------------------|
// | comments | GET /repos/{o}/{r}/issues/comments?since=…&sort=created (issues and pull requests) |
// | reviews  | GET /repos/{o}/{r}/pulls?state=all&sort=updated → GET …/pulls/{n}/reviews         |
// | checks   | GET /repos/{o}/{r}/pulls?state=open → GET …/commits/{sha}/check-runs and /status   |
//
// Only NEW comments are events: GitHub's `since` also returns edited comments, and those are
// dropped (QUESTIONS #43). Events are triggers; gates read the current state before deciding.
import type {
  CheckCompletedEvent,
  EventCursor,
  GitEvent,
  RepoRef,
  ReviewSubmittedEvent,
} from '@sdlc/contracts';

import {
  advance,
  decodeCursor,
  encodeCursor,
  initialState,
  isNew,
  toSeconds,
  type CursorState,
  type Handled,
  type Stream,
  type StreamState,
} from './cursor.js';
import type { GitHubHttp } from './http.js';
import { arr, int, obj, repoPath, sha, time } from './json.js';
import { checkRunEvent, commentEvent, reviewEvent, statusEvent } from './mapping.js';
import type { ResolvedOptions } from './options.js';
import { listPages } from './pages.js';

interface StreamResult<E extends GitEvent> {
  readonly events: E[];
  readonly next: StreamState;
}

export class Poller {
  readonly #options: ResolvedOptions;
  readonly #http: GitHubHttp;

  constructor(options: ResolvedOptions, http: GitHubHttp) {
    this.#options = options;
    this.#http = http;
  }

  async poll(
    ref: RepoRef,
    cursor: EventCursor,
    auth: string,
  ): Promise<{ events: GitEvent[]; next: EventCursor }> {
    const state = decodeCursor(cursor);
    const base = repoPath(ref);
    if (!state) {
      // First poll of a project: start at GitHub's current time, without history.
      const res = await this.#http.json('GET', base, { auth });
      const now = res.date ?? this.#options.now();
      return { events: [], next: encodeCursor(initialState(Math.floor(now.getTime() / 1000))) };
    }
    const repo = { owner: ref.owner, name: ref.name };
    const comments = await this.#comments(repo, base, state.comments, auth);
    const reviews = await this.#reviews(repo, base, state.reviews, auth);
    const checks = await this.#checks(repo, base, state.checks, auth);
    const next: CursorState = {
      comments: comments.next,
      reviews: reviews.next,
      checks: checks.next,
    };
    const events: GitEvent[] = [...comments.events, ...reviews.events, ...checks.events].sort(
      (a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id),
    );
    return { events, next: encodeCursor(next) };
  }

  #truncated(repo: RepoRef, stream: Stream): void {
    this.#options.logger.log('warn', 'git_host.poll_truncated', {
      repo: `${repo.owner}/${repo.name}`,
      stream,
    });
  }

  async #comments(
    repo: RepoRef,
    base: string,
    stream: StreamState,
    auth: string,
  ): Promise<StreamResult<GitEvent>> {
    const list = await listPages(this.#http, `${base}/issues/comments`, {
      auth,
      maxPages: this.#options.maxPagesPerPoll,
      query: {
        since: new Date(stream.t * 1000).toISOString(),
        sort: 'created',
        direction: 'asc',
      },
    });
    if (list.truncated) this.#truncated(repo, 'comments');
    const events: GitEvent[] = [];
    const handled: Handled[] = [];
    for (const item of list.items) {
      const created = toSeconds(time(obj(item, 'comment').created_at, 'comment.created_at'));
      const key = String(int(obj(item, 'comment').id, 'comment.id'));
      // Edited comments come back with an older creation time: never an event (QUESTIONS #43).
      if (!isNew(stream, key, created)) continue;
      events.push(commentEvent(repo, item, 'polling'));
      handled.push({ key, at: created });
    }
    // The list is sorted by creation time, so items after the page limit are newer: no ceiling.
    return { events, next: advance(stream, handled, this.#options.pollOverlapSeconds) };
  }

  async #reviews(
    repo: RepoRef,
    base: string,
    stream: StreamState,
    auth: string,
  ): Promise<StreamResult<ReviewSubmittedEvent>> {
    const updated = (pr: unknown) => toSeconds(time(obj(pr, 'pull').updated_at, 'pull.updated_at'));
    // Submitting a review updates the pull request, so recently updated pull requests are enough.
    const pulls = await listPages(this.#http, `${base}/pulls`, {
      auth,
      maxPages: this.#options.maxPagesPerPoll,
      query: { state: 'all', sort: 'updated', direction: 'desc' },
      stopAt: (pr) => updated(pr) < stream.t,
    });
    let ceiling: number | undefined;
    if (pulls.truncated && pulls.items.length > 0) {
      this.#truncated(repo, 'reviews');
      ceiling = updated(pulls.items[pulls.items.length - 1]);
    }
    const events: ReviewSubmittedEvent[] = [];
    const handled: Handled[] = [];
    for (const pr of pulls.items) {
      const number = int(obj(pr, 'pull').number, 'pull.number');
      const reviews = await listPages(this.#http, `${base}/pulls/${number}/reviews`, {
        auth,
        maxPages: this.#options.maxPagesPerPoll,
      });
      for (const item of reviews.items) {
        const event = reviewEvent(repo, number, item, 'polling');
        if (!event) continue;
        const at = toSeconds(event.occurredAt);
        if (!isNew(stream, event.reviewId, at)) continue;
        events.push(event);
        handled.push({ key: event.reviewId, at });
      }
    }
    return { events, next: advance(stream, handled, this.#options.pollOverlapSeconds, ceiling) };
  }

  async #checks(
    repo: RepoRef,
    base: string,
    stream: StreamState,
    auth: string,
  ): Promise<StreamResult<CheckCompletedEvent>> {
    const max = this.#options.maxOpenPullRequests;
    const open = await listPages(this.#http, `${base}/pulls`, {
      auth,
      maxPages: Math.ceil(max / 100),
      query: { state: 'open', sort: 'updated', direction: 'desc' },
    });
    if (open.items.length > max || open.truncated) this.#truncated(repo, 'checks');
    const heads = new Map<string, number[]>();
    for (const pr of open.items.slice(0, max)) {
      const p = obj(pr, 'pull');
      const head = sha(obj(p.head, 'pull.head').sha, 'pull.head.sha');
      heads.set(head, [...(heads.get(head) ?? []), int(p.number, 'pull.number')]);
    }
    const events: CheckCompletedEvent[] = [];
    const handled: Handled[] = [];
    const take = (event: CheckCompletedEvent | null, key: string) => {
      if (!event) return;
      const at = toSeconds(event.occurredAt);
      if (!isNew(stream, key, at)) return;
      events.push(event);
      handled.push({ key, at });
    };
    for (const [head, prNumbers] of heads) {
      const runs = await listPages(this.#http, `${base}/commits/${head}/check-runs`, {
        auth,
        maxPages: this.#options.maxPagesPerPoll,
        query: { filter: 'latest' },
        extract: (body) => arr(obj(body, 'check_runs').check_runs, 'check_runs'),
      });
      for (const run of runs.items) {
        const event = checkRunEvent(repo, run, prNumbers, 'polling');
        take(event, `r${event?.checkId ?? ''}`);
      }
      const status = await this.#http.json('GET', `${base}/commits/${head}/status`, {
        auth,
        cache: true,
        query: { per_page: 100 },
      });
      for (const item of arr(obj(status.body, 'status').statuses, 'statuses')) {
        const event = statusEvent(repo, head, item, prNumbers, 'polling');
        take(event, `s${event?.checkId ?? ''}`);
      }
    }
    return { events, next: advance(stream, handled, this.#options.pollOverlapSeconds) };
  }
}
