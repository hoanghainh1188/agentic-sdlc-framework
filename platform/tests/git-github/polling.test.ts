// D-08 B05 AC2: read new events (comments, reviews, CI status) by polling the GitHub API, with a
// cursor the caller stores (git_event_cursors; the restart test on PostgreSQL is
// tests/integration/db/git-event-cursor.test.ts). No event is returned twice; edited comments
// never produce events (QUESTIONS #43). Against the in-process GitHub stub.
import { INITIAL_EVENT_CURSOR, type EventCursor, type GitEvent } from '@sdlc/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startHarness, type Harness } from './helpers';
import {
  checkRun,
  comment,
  pull,
  REPO,
  review,
  SHA_A,
  status,
  user,
  type StubAnswer,
  type StubRequest,
} from './stub-github';

let h: Harness;

/** What the stub's repository holds; tests change it between polls. */
interface RepoData {
  comments: ReturnType<typeof comment>[];
  pulls: ReturnType<typeof pull>[];
  reviews: Record<number, ReturnType<typeof review>[]>;
  runs: ReturnType<typeof checkRun>[];
  statuses: ReturnType<typeof status>[];
}
let data: RepoData;

const T0 = '2026-09-26T08:00:00Z'; // stub clock at the first poll
const at = (minutes: number, seconds = 0) =>
  new Date(Date.parse(T0) + minutes * 60_000 + seconds * 1000).toISOString().replace('.000Z', 'Z');

function install(stub: Harness['stub']): void {
  stub.on('GET', '/repos/acme/shop', { body: { id: 1, full_name: 'acme/shop' } });
  stub.on('GET', '/repos/acme/shop/issues/comments', (req: StubRequest) => {
    const since = Date.parse(req.query.get('since') ?? '');
    const items = data.comments
      .filter((c) => Date.parse(c.updated_at) >= since)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    return paged(req, items, '/repos/acme/shop/issues/comments');
  });
  stub.on('GET', '/repos/acme/shop/pulls', (req: StubRequest) => {
    const state = req.query.get('state');
    const items = data.pulls
      .filter((p) => state === 'all' || p.state === state)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return paged(req, items, '/repos/acme/shop/pulls');
  });
  for (const n of [7, 8, 9]) {
    stub.on('GET', `/repos/acme/shop/pulls/${n}/reviews`, () => ({ body: data.reviews[n] ?? [] }));
  }
  stub.on('GET', `/repos/acme/shop/commits/${SHA_A}/check-runs`, () => ({
    body: { total_count: data.runs.length, check_runs: data.runs },
  }));
  stub.on('GET', `/repos/acme/shop/commits/${SHA_A}/status`, () => ({
    body: { state: 'pending', statuses: data.statuses },
  }));
}

/** Pages of `per_page` items with a GitHub `Link` header. */
function paged(req: StubRequest, items: unknown[], path: string): StubAnswer {
  const perPage = Number(req.query.get('per_page') ?? '30');
  const page = Number(req.query.get('page') ?? '1');
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const more = items.length > page * perPage;
  const next = new URLSearchParams(req.query);
  next.set('page', String(page + 1));
  return {
    body: slice,
    headers: more ? { link: `<${h.stub.address}${path}?${next.toString()}>; rel="next"` } : {},
  };
}

async function poll(cursor: EventCursor, extra = {}) {
  return h.adapter(extra).listEventsSince(REPO, cursor);
}

/** First poll of a new project: the cursor starts at the stub's current time. */
async function start(): Promise<EventCursor> {
  const first = await poll(INITIAL_EVENT_CURSOR);
  expect(first.events).toEqual([]);
  return first.next;
}

const ids = (events: GitEvent[]) => events.map((e) => e.id);

beforeEach(async () => {
  h = await startHarness();
  data = { comments: [], pulls: [], reviews: {}, runs: [], statuses: [] };
  install(h.stub);
});

afterEach(async () => {
  await h.stub.stop();
});

describe('first poll of a project', () => {
  it('starts at GitHub time without history and reads no event list', async () => {
    data.comments = [comment(1, 3, at(-10), '/approve G1')];
    const cursor = await start();
    expect(JSON.parse(cursor)).toMatchObject({
      v: 1,
      comments: { t: Date.parse(T0) / 1000, seen: [] },
    });
    expect(h.stub.requestsTo('GET', '/repos/acme/shop/issues/comments')).toHaveLength(0);
    // The old comment stays history.
    expect((await poll(cursor)).events).toEqual([]);
  });

  it('refuses a malformed cursor without calling GitHub (never a silent reset)', async () => {
    for (const bad of ['{', '{"v":2}', 'null', '[]', '{"v":1,"comments":{"t":1,"seen":[]}}']) {
      await expect(poll(bad as EventCursor)).rejects.toMatchObject({ code: 'invalid_cursor' });
    }
    expect(h.stub.requests.filter((r) => !r.path.includes('installation'))).toHaveLength(0);
  });
});

describe('comments', () => {
  it('returns new comments on issues and pull requests, oldest first, with references', async () => {
    const cursor = await start();
    h.stub.now = new Date(at(5));
    data.comments = [
      comment(11, 3, at(2), '/approve G3', { pull: true }),
      comment(10, 3, at(1), '/reject G2 spec_unclear'),
    ];
    const { events, next } = await poll(cursor);
    expect(events).toEqual([
      {
        kind: 'comment_created',
        id: 'github:comment:10',
        source: 'polling',
        repo: REPO,
        occurredAt: new Date(at(1)).toISOString(),
        url: 'https://github.com/acme/shop/issues/3#issuecomment-10',
        issueNumber: 3,
        isPullRequest: false,
        commentId: '10',
        author: { id: '1001', login: 'harry', type: 'user' },
        body: '/reject G2 spec_unclear',
      },
      expect.objectContaining({ id: 'github:comment:11', isPullRequest: true }),
    ]);
    const [req] = h.stub.requestsTo('GET', '/repos/acme/shop/issues/comments');
    expect(Object.fromEntries(req!.query)).toMatchObject({
      since: new Date(T0).toISOString(),
      sort: 'created',
      direction: 'asc',
      per_page: '100',
    });
    // Nothing new: nothing returned, even though the overlap window reads them again.
    expect((await poll(next)).events).toEqual([]);
  });

  it('never returns an edited comment (QUESTIONS #43), even when edited into a command', async () => {
    data.comments = [comment(1, 3, at(-60), 'LGTM')];
    const cursor = await start();
    data.comments = [comment(1, 3, at(-60), '/approve G3', { updatedAt: at(1) })];
    expect((await poll(cursor)).events).toEqual([]);
  });

  it('finds a comment GitHub shows late, inside the overlap window, exactly once', async () => {
    let cursor = await start();
    data.comments = [comment(20, 3, at(1, 30), 'first')];
    ({ next: cursor } = await poll(cursor));
    // Created earlier than the last one, visible only now (replication delay).
    data.comments.push(comment(19, 3, at(1, 0), 'late'), comment(21, 3, at(1, 30), 'same second'));
    const second = await poll(cursor);
    expect(ids(second.events)).toEqual(['github:comment:19', 'github:comment:21']);
    expect((await poll(second.next)).events).toEqual([]);
  });

  it('continues after the page limit without losing or repeating comments', async () => {
    let cursor = await start();
    data.comments = Array.from({ length: 250 }, (_, i) => comment(100 + i, 3, at(1, i), `c${i}`));
    const seen: string[] = [];
    // The overlap window re-reads up to 60 s of handled comments, so each poll makes less than a
    // full page of progress; it always makes some.
    for (let i = 0; i < 10; i += 1) {
      const res = await poll(cursor, { maxPagesPerPoll: 1 });
      cursor = res.next;
      if (res.events.length === 0) break;
      seen.push(...ids(res.events));
    }
    expect(seen).toEqual(data.comments.map((c) => `github:comment:${c.id}`));
    expect(h.logs.filter((l) => l.event === 'git_host.poll_truncated').length).toBeGreaterThan(1);
  });
});

describe('reviews', () => {
  it('returns submitted reviews of recently updated pull requests, not pending ones', async () => {
    const cursor = await start();
    const b = user(3003, 'person-b');
    data.pulls = [pull(7, at(3)), pull(8, at(-30))];
    data.reviews = {
      7: [review(70, b, 'APPROVED', at(3)), review(71, b, 'PENDING', null)],
      8: [review(80, b, 'APPROVED', at(-30))],
    };
    const { events, next } = await poll(cursor);
    expect(events).toEqual([
      {
        kind: 'review_submitted',
        id: 'github:review:70',
        source: 'polling',
        repo: REPO,
        occurredAt: new Date(at(3)).toISOString(),
        url: 'https://github.com/acme/shop/pull/7#pullrequestreview-70',
        prNumber: 7,
        reviewId: '70',
        reviewer: { id: '3003', login: 'person-b', type: 'user' },
        state: 'approved',
        commitSha: SHA_A,
      },
    ]);
    // The pull request not updated since the cursor is not read.
    expect(h.stub.requestsTo('GET', '/repos/acme/shop/pulls/8/reviews')).toHaveLength(0);
    expect((await poll(next)).events).toEqual([]);
  });

  it('keeps the lower bound below pull requests it could not reach (page limit)', async () => {
    let cursor = await start();
    const b = user(3003, 'person-b');
    data.pulls = Array.from({ length: 150 }, (_, i) => ({
      ...pull(9, at(10, -i)),
      number: 1000 + i,
    }));
    data.pulls.push(pull(8, at(2)));
    data.reviews = { 8: [review(80, b, 'APPROVED', at(2))] };
    for (let n = 1000; n < 1150; n += 1)
      h.stub.on('GET', `/repos/acme/shop/pulls/${n}/reviews`, { body: [] });
    let res = await poll(cursor, { maxPagesPerPoll: 1 });
    expect(res.events).toEqual([]);
    const state = JSON.parse(res.next) as { reviews: { t: number } };
    expect(state.reviews.t).toBeLessThanOrEqual(Date.parse(at(10, -99)) / 1000);
    // Once fewer pull requests are recent, the older one is reached.
    data.pulls = data.pulls.slice(100);
    cursor = res.next;
    res = await poll(cursor, { maxPagesPerPoll: 1 });
    expect(ids(res.events)).toEqual(['github:review:80']);
  });
});

describe('CI status', () => {
  it('returns finished check runs and commit statuses of open pull requests once', async () => {
    const cursor = await start();
    data.pulls = [pull(7, at(1)), { ...pull(8, at(1)), state: 'closed' }];
    data.runs = [checkRun(501, 'lint', 'success', at(2)), checkRun(502, 'test', null, null)];
    data.statuses = [
      status(601, 'ci/build', 'failure', at(3)),
      status(602, 'ci/e2e', 'pending', at(3)),
    ];
    const first = await poll(cursor);
    expect(first.events).toEqual([
      expect.objectContaining({
        kind: 'check_completed',
        id: 'github:check_run:501',
        sha: SHA_A,
        prNumbers: [7],
        checkSource: 'check_run',
        conclusion: 'success',
        url: 'https://github.com/acme/shop/runs/501',
      }),
      expect.objectContaining({
        id: 'github:status:601',
        checkSource: 'status',
        conclusion: 'failure',
        url: 'https://ci.example.com/build/601',
      }),
    ]);
    // The running check finishes later: returned once.
    data.runs[1] = checkRun(502, 'test', 'failure', at(4));
    const second = await poll(first.next);
    expect(ids(second.events)).toEqual(['github:check_run:502']);
    expect((await poll(second.next)).events).toEqual([]);
  });
});

describe('all streams together', () => {
  it('sorts events by time, then ID', async () => {
    const cursor = await start();
    data.comments = [comment(1, 7, at(2), '/approve G7', { pull: true })];
    data.pulls = [pull(7, at(3))];
    data.reviews = { 7: [review(70, user(3003, 'b'), 'APPROVED', at(1))] };
    data.runs = [checkRun(501, 'lint', 'success', at(2))];
    const { events } = await poll(cursor);
    expect(ids(events)).toEqual(['github:review:70', 'github:check_run:501', 'github:comment:1']);
  });
});
