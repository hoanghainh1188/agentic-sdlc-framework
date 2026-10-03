# ADR-M23. GitHub adapter: HTTP client, App authentication, polling cursor, webhook check

| Item | Value |
|---|---|
| Status | **Proposed** (task B05, PR for review) |
| Date | 2026-09-26 |
| Decided by | Harry (plan approved 2026-09-26; QUESTIONS #42 option A, #43; native `fetch`) |
| Related | D-02 FR-11, FR-21, FR-22; D-03 sections 5.1, 7.1, 8.2, 9, 12 (ADR-M07, ADR-M11) (version 1.4); D-05 sections 6.1, 9; D-08 tasks B05, B06, B08, C04, C08, C11, E01; ADR-M16, ADR-M18, ADR-M19, ADR-M21; QUESTIONS #42–#45 |

## 1. Context

Task B05 builds the first Git host adapter: GitHub, through a GitHub App. D-03 §7.1 fixes the interface (`GitHostAdapter`). It does not fix:

- which HTTP client or library to use;
- how the App key is read and how tokens are limited and cached;
- how polling finds comments, reviews and CI results, and how the cursor avoids returning an event twice;
- what the webhook check does before webhooks exist;
- how the adapter reports errors, given that adapters import only `@sdlc/contracts` (ADR-M16 §2.5).

## 2. Decision

### 2.1. HTTP client: Node's built-in `fetch`, no dependency

- The adapter calls the GitHub REST API (version `2022-11-28`) with Node 24's built-in `fetch`. JWT signing uses `node:crypto`. The adapter has **no third-party dependency**, like the OpenBao client (ADR-M21).
- GETs are retried after a network error, a timeout or a 5xx answer: `maxRetries` (default 2), delay `retryBaseDelayMs` (default 500 ms) doubled each time. **POSTs are never retried by the adapter**: a retry could post a comment twice. The caller (a Temporal activity) decides.
- Rate limits: a 403 or 429 with `x-ratelimit-remaining: 0` or `retry-after` gives `rate_limited` with `retry_at`. The adapter never sleeps until the reset. A remaining quota below 200 is logged as a warning.
- List calls send `If-None-Match` (ETag). A 304 answer does not count against GitHub's rate limit; the adapter reuses the cached body.
- Pagination follows `Link: rel="next"`, only when the link stays on the API host and path (the token is never sent elsewhere). Redirects are refused.
- Answers are checked field by field (`json.ts`); a wrong shape is `invalid_response`, never a guess. JSON answers are capped at 10 MiB.

### 2.2. GitHub App authentication

- The App key is read with `SecretReader.read('shared/github-app')` (D-03 §8.2): fields `client_id` (or `app_id`) and `private_key` (RSA PEM). Never from an environment variable or a file. It is held as a `KeyObject` and read again after `keyCacheSeconds` (default 600 s), so a rotated key needs no restart.
- The OpenBao policies of `api` and `worker` can read this path (QUESTIONS #42). The `runner` cannot since C04: the worker hands it the run's token response-wrapped (QUESTIONS #44, ADR-M25 §2.11).
- App JWT: RS256, `iat` = now − 60 s, `exp` = now + 9 min, `iss` = the client ID.
- The installation is found with `GET /repos/{owner}/{repo}/installation` and cached. The database needs no installation ID.
- **Every installation token is limited to one repository** (`repositories: [name]`) and to the requested permissions. The answer is checked: a token for other or more repositories, or with wider permissions, is refused (`invalid_response`).
- The adapter's own token (per repository) has `checks`, `contents`, `pull_requests`, `statuses`: read, and `issues`: write (comments). It is cached until `tokenRefreshMarginSeconds` (default 300 s) before it expires; concurrent calls share one mint. After a 401 the cached token is dropped and the call is tried once more.
- `issueShortLivedToken` accepts only `contents`, `pull_requests`, `issues`, `checks`, `statuses` with `read` or `write`. Its tokens are never cached: each call gives a new token, owned by the caller (C04, C11).

**GitHub App settings (minimal, B05):** repository permissions Metadata: read, Issues: read and write, Pull requests: read, Checks: read, Commit statuses: read, Contents: read. No organisation or account permissions. No webhook subscription. Installed on selected repositories only. C08 (ADR-M38 §2.3, §4): Contents: read and write (the runner pushes `agent/*` with a single-repository token issued for one push; the sandbox never pushes, QUESTIONS #52) and Pull requests: read and write (the adapter opens the pull request with a token minted for that call; its cached token stays read-only). C08 PR 2: Code scanning alerts: read (QUESTIONS #157; `getSecurityFindings` mints a token with `security_events: read` for the call).

### 2.3. Polling and the cursor

| Events | Endpoints |
|---|---|
| New comments (issues and pull requests) | `GET /repos/{o}/{r}/issues/comments?since=T&sort=created&direction=asc` |
| Submitted reviews | `GET /repos/{o}/{r}/pulls?state=all&sort=updated&direction=desc` until `updated_at < T`, then `GET …/pulls/{n}/reviews` |
| Finished CI checks | open pull requests (at most `maxOpenPullRequests`, default 50) → `GET …/commits/{head}/check-runs?filter=latest` and `GET …/commits/{head}/status` |

- **Only new comments are events** (QUESTIONS #43). `since` returns edited comments too; a comment created before the lower bound is dropped.
- The cursor is JSON with one stream per kind: `{ "comments": { "seen": [[id, time]…], "t": time }, "reviews": …, "checks": …, "v": 1 }`. It holds **only Unix times (from GitHub's clock) and numeric IDs**, never text. It is written with a fixed key order and parsed strictly: a malformed cursor is `invalid_cursor` and is **never reset silently**.
- `t` is the lower bound. After a poll it moves to the newest handled item minus the overlap window (`pollOverlapSeconds`, default 60 s), so items GitHub shows a little late are still found. `seen` holds the items handled inside the window, so no item is returned twice. At most 500 items are kept; above that the lower bound moves past the dropped ones.
- Page limit: `maxPagesPerPoll` pages of 100 per stream (default 4). Comments are sorted by creation time, so the next poll continues. For reviews, the lower bound never passes the last pull request reached (a "ceiling"). A truncated poll logs `git_host.poll_truncated`.
- A new project starts with `INITIAL_EVENT_CURSOR` (`''`): the first poll reads GitHub's current time and returns no history.
- **Who stores the cursor:** the adapter only returns `next`. The poller (B06, worker) stores it with `TenantScope.gitEventCursors.save()` (table and repository from A06; no migration in B05). B06 must store the cursor in the same transaction as the effects of the events, or make its handler idempotent by `event.id`; otherwise a crash between the two handles an event again.
- **Events are triggers.** Gates read the current state (`getApprovals`, `getCheckStatus`) before they decide, so a late or missed event delays a gate but cannot pass it wrongly.
- Assumption to check with the live test: submitting a review updates the pull request's `updated_at` (the review scan depends on it).
- Cost: about 1 + 2 calls per open pull request per poll, most of them answered 304. With 5 open pull requests and a 30-second interval: about 1,400 calls per hour, against 5,000 per installation.

### 2.4. Events and the shared types

- `GitEvent` = `comment_created` | `review_submitted` | `check_completed` (`@sdlc/contracts`, D-03 §7.1 notes). Each has a stable `id` (`github:comment:<id>`, `github:review:<id>`, `github:check_run:<id>`, `github:status:<id>`), the same for polling and webhooks, and a `url`.
- Only `comment_created.body` is free text; B06 parses it and must never store it. Append-only tables store the `url` or numeric IDs only (for example `gate_decisions.reason_ref` = the comment URL).
- Actors (`GitActor`) carry the numeric account ID, the login (display only) and `type: user | bot`. B06 and E01 map users by the numeric ID; bots never count as approvers (QUESTIONS #45).
- `PullRequestInfo` has no title or body. `getChangedFiles` returns both paths of a rename and fails (`too_many_files`, `invalid_response`) instead of returning a partial list, because G5 compares the list with the plan. `getApprovals` returns each reviewer's latest decision (a comment does not change it), with the reviewed commit. `getFileAtCommit` takes a commit SHA only (a branch can move), returns the exact UTF-8 text (BOM and line endings kept, non-UTF-8 refused) and is capped by `maxFileBytes` (default 1 MiB).

### 2.5. Webhook check, not wired

- `verifyWebhook` checks `X-Hub-Signature-256` (HMAC-SHA-256 of the raw body with the webhook secret, constant-time compare) before reading the body. Without a configured secret it refuses every request (`webhook_disabled`), which is the MVP state.
- It maps `issue_comment` `created`, `pull_request_review` `submitted` / `dismissed`, `check_run` `completed` and `status` to the same `GitEvent` with `source: 'webhook'`. Other events are `unsupported_event`. There is no HTTP route yet (ADR-M11).

### 2.6. Errors, logs, settings

- The adapter throws `GitHostError` (`@sdlc/contracts`) with a code from `GIT_HOST_ERROR_CODES` and safe parameters only (status codes, repository names, limits, times). Apps render it with `gitHostErrorMessage` (`@sdlc/core`), which maps each code to a catalog key `git_host.error.<code>` (NFR-08, ADR-M18).
- Logs go through the `GitHostLogger` interface with event codes and safe fields. Tokens, JWTs, the key and comment text are never logged. Tokens are `RedactedSecret`s.
- Settings (`GitHubAdapterOptions`) are technical, not handbook rules, so they are not project configuration: API URL, timeouts, retries, token and key cache times, overlap, page and pull request limits, file size. The polling **interval** is project configuration (`github.poll_interval_seconds`, default 30 s, D-02 §6.3) and belongs to the poller (B06). B06 wires the options into the worker.

### 2.7. Tests

- Unit tests run against an in-process GitHub stub (`platform/tests/git-github/stub-github.ts`) with recorded answer shapes and a real RSA key per run; the stub verifies the JWT like GitHub.
- A DB integration test (`pnpm test:db`) stores the cursor in `git_event_cursors`, creates a new adapter instance and checks that no event comes back twice.
- An optional live test (`platform/tests/integration/github/live.test.ts`) uses a **test** GitHub App and repository. It runs only when `SDLC_GITHUB_LIVE_TEST=1` and `SDLC_GITHUB_TEST_APP_FILE` point to a settings file outside the repository. A static test checks that no CI workflow sets these variables.

## 3. Alternatives not chosen

| Option | Why not |
|---|---|
| Octokit (`@octokit/core`, `auth-app`, `plugin-retry`, `plugin-throttling`; MIT) | About 15 packages for about 10 endpoints; less control over what is logged and retried (a retried POST can double a comment). Kept as an option if the surface grows |
| Repository events API (`GET /repos/{o}/{r}/events`) for polling | Delayed by 30 s to 6 h, limited to 300 events; not reliable for approvals |
| A cursor with only a timestamp | Loses items GitHub shows late, or returns items twice at the boundary second |
| Treat edited comments as new events | An old comment could be edited into an approval (QUESTIONS #43) |
| Installation ID stored per project | Needs a migration and an admin step; the lookup is one cached call |

## 4. Consequences

- Later tasks add methods with a D-03 update: opening a pull request (C08), revoking a short-lived token (C11 AC2), the merge event (E01).
- B06 stores the cursor, handles events idempotently by `event.id`, maps users by numeric ID and ignores bots as approvers.
- C04 decided that the runner no longer reads the App key (QUESTIONS #44, ADR-M25 §2.11).
- GitHub Free has no branch protection on private repositories; C08 AC3 (an agent push to `main` is blocked) needs a plan that has it, or a public test repository (R03, C08).

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-09-26 | Claude (task B05) | First version |
