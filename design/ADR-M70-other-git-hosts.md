# ADR-M70. Other Git hosts (GitLab.com, Bitbucket Cloud, Backlog): result of the X09 spike

| Item | Value |
|---|---|
| Status | **Accepted** (repository owner, 2026-10-21; result of task X09) |
| Date | 2026-10-21 |
| Decided by | The repository owner (plan approved on 2026-10-21: cloud versions only, desk research from the official documentation; the decisions of §5 on 2026-10-21) |
| Related | D-08 tasks X09, X10; D-02 NFR-05; D-03 §7.1; ADR-M11 (polling), ADR-M23 (the GitHub App), ADR-M25 (tokens in the sandbox), ADR-M38, ADR-M41 (G7), ADR-M42 §2.4 (revoking tokens), ADR-M49; design/QUESTIONS.md #361, #511–#513 |
| Spike code | `platform/spikes/git-hosts/` (`matrix.json`; may be thrown away) |

## 1. Context

Clients use GitLab, Backlog Git and Bitbucket besides GitHub (QUESTIONS #361). The platform reaches a Git host only through `GitHostAdapter` (D-03 §7.1, `platform/packages/contracts/src/git-host.ts`); GitHub is the only adapter. Adapters for other hosts wait for a real project (task X10). This spike answers three questions:

1. Which of the adapter's methods can each host's API do (D-08 X09 AC1)?
2. What is missing for G6 (independent verification) and G7 (review and merge), and is there a workaround, or must the platform refuse (AC2)?
3. In which order should adapters be built, and how much work is each (AC3)?

**Scope** (repository owner, 2026-10-21): the cloud services only, `gitlab.com`, Bitbucket Cloud and Backlog (`backlog.com`, `backlog.jp`). Self-managed GitLab and Bitbucket Data Center are out of scope.

**Method and its limit.** Desk research from official documentation: `docs.gitlab.com`, `developer.atlassian.com` and `support.atlassian.com`, `developer.nulab.com` and `support.nulab.com`. The network proxy of the session that did the research blocked these sites, so the facts come from the text of the official pages as quoted by a search tool, not from full pages; for Backlog also from the source of Nulab's own client libraries (`nulab/backlog-js`, `nulab/backlog4j`), read in full. Facts that no source stated are marked *unconfirmed* in the spike's notes. §4 lists what to check on a live account before X10. All sources were accessed on 2026-10-21.

**The methods.** D-08 X09 AC1 names 19 methods. The interface has **22** today: L07 added `getMergedChange`, `getCommitParents` and `compareChangedFiles`. The spike compares all 22.

**What the platform needs from a host** (from ADR-M23, M25, M38, M41, M42, M49):

- A token for **one repository**, with chosen permissions, that lives about an hour and can be **revoked at once** (the runner's clone and push tokens, R028, R031).
- Reviews **bound to the commit** that was reviewed, the latest decision of each reviewer (approved, changes requested, dismissed), the accounts of the commit authors, and who merged and when (G7, R029: the producer never approves).
- CI results and security findings of a commit (G6).
- Users identified by a **stable numeric or opaque account ID**, never by name (R037).
- Events read by polling (ADR-M11), and signed webhooks later.

## 2. Results

Codes: **works** (one documented call), **partial** (a documented workaround, or a part is missing), **git** (no API; only with git on a local clone), **missing** (no way found). The full matrix is `platform/spikes/git-hosts/matrix.json`.

### 2.1. Method by method

| # | Method | GitLab.com | Bitbucket Cloud | Backlog |
|---|---|---|---|---|
| 1 | `createIssueComment` | works | partial (pull requests only: the issue tracker API is gone, issues are in Jira) | works |
| 2 | `getPullRequest` | works | works (no merged-time field: use the activity) | partial (status codes and the head commit *unconfirmed*) |
| 3 | `getChangedFiles` | partial (lists are cut at 1,000 files; detect it and refuse) | works | git |
| 4 | `getCheckStatus` | works | works | **missing** (no CI) |
| 5 | `getApprovals` | partial (no commit per approval) | partial (no commit per approval) | **missing** (no approvals) |
| 6 | `getReviews` | partial (one state per reviewer; no review object, no "dismissed") | partial (same) | **missing** |
| 7 | `getCommitAuthors` | partial (e-mails only, no user IDs) | works (an account only when the e-mail is known) | git (e-mails only) |
| 8 | `getMergedChange` | works (by several calls) | partial (strategy only from the parent count) | partial (merge commit from the API, the rest from git) |
| 9 | `getCommitParents` | works | works | git |
| 10 | `compareChangedFiles` | partial (cut at 1,000 files; `compare_timeout` shows it) | works | git |
| 11 | `getFileAtCommit` | works | works | git |
| 12 | `getBranchHead` | works | works | git |
| 13 | `listPaths` | works | partial (walk the tree by directory) | git |
| 14 | `issueShortLivedToken` | partial (Premium; expiry is a whole day; created with a long-lived maintainer token) | **missing** (no API for a one-repository token) | **missing** (no token limited to a repository) |
| 15 | `revokeShortLivedToken` | partial (self-revoke *unconfirmed* for project tokens) | **missing** | **missing** |
| 16 | `openPullRequest` | works | works | works |
| 17 | `findOpenPullRequest` | works | works | partial (filter on our side) |
| 18 | `getSecurityFindings` | partial (Ultimate; on lower tiers parse the SAST report artifact, *unconfirmed*) | partial (only reports that a scanner writes) | **missing** |
| 19 | `getReviewFeedback` | partial (no review ID: discussions and notes) | partial (no review object: comments) | partial (comments; line positions *unconfirmed*) |
| 20 | `getIssueComment` | partial (needs the noteable, not only the comment ID) | partial (needs the pull request) | partial (needs the pull request) |
| 21 | `listEventsSince` | partial (no project-wide feed: poll changed merge requests, then fan out) | partial (activity feed without a cursor: poll by `updated_on`) | works (activity feed with an ID cursor) |
| 22 | `verifyWebhook` | works (HMAC signing token) | works (HMAC `X-Hub-Signature`) | **missing** (webhooks are not signed) |
| | **Count** (works / partial / git / missing) | 11 / 11 / 0 / 0 | 11 / 9 / 0 / 2 | 3 / 5 / 7 / 7 |

### 2.2. G7 (review and merge)

| Need | GitLab.com | Bitbucket Cloud | Backlog |
|---|---|---|---|
| A review bound to a commit | Not stored. The platform binds it: the head commit of the merge request's latest diff version older than the approval time | Not stored. Bind it with the pushes in the activity feed and the approval time | No approvals at all |
| Latest decision per reviewer, with "dismissed" | One state per reviewer (`approved`, `requested_changes`); a new push removes approvals by default; no "dismissed": a removed approval counts as dismissed | `approved` or `changes_requested` per participant; a reset on push only with a setting | Only with comment commands (`/approve`) read by polling, every push counts as a dismissal |
| The producer never approves (R029) | The platform's own check, with commit authors mapped from e-mails; an author it cannot map makes G7 fail (fail closed) | The platform's own check; author accounts are mapped by the host when known | The platform's own check; authors are free-text e-mails; the agent is an ordinary user the platform lists itself |
| Who merged and when | `merge_user` and `merged_at` (with auto-merge, the person who set it) | `closed_by`; the time from the activity | `mergeAt`; who merged is not documented |
| The host stops a merge without approval | **Premium**: required approvals, no approval by the author or by committers, approvals removed on push | **Premium**: enforced merge checks (on Free and Standard they only warn) | **No**: branch protection limits pushes, not merges |

### 2.3. G6 (independent verification)

| Need | GitLab.com | Bitbucket Cloud | Backlog |
|---|---|---|---|
| CI results of a commit | Commit statuses and pipelines | Build statuses (Pipelines and external CI) | **None**: a CI outside Backlog, read through its own API |
| Security findings | **Ultimate** API; lower tiers: the SAST report artifact (*unconfirmed*) | Code Insights reports written by a scanner; none means "no evidence", never "pass" | **None**: from the external scanner |
| A complete list of changed files | Cut at 1,000 files on gitlab.com: detect it and refuse (fail closed) | Complete (paginated) | From git |

### 2.4. Tokens (the largest gap)

None of the three hosts gives what the GitHub App gives: a one-hour token for one repository, with chosen permissions, created and revoked by API.

- **GitLab.com:** project access tokens (Premium) are limited to one project and can be revoked, but they expire at midnight UTC (a day at least), have coarse scopes (`api`, `read_api`, `read_repository`, `write_repository`) and are created with a token of a human or service account with Maintainer rights, which then becomes a long-lived, high-value secret in OpenBao.
- **Bitbucket Cloud:** repository access tokens are limited to one repository, but are created and revoked only in the web interface. OAuth client-credentials tokens live 2 hours but reach every repository of the workspace and cannot be revoked by API.
- **Backlog:** API keys and OAuth tokens act with all the rights of their user; OAuth tokens live 1 hour and cannot be revoked; Git over HTTPS uses the user's password. The only limit is a dedicated user who is a member of one project only (a paid seat).

### 2.5. Other facts

- **User IDs:** stable on all three (GitLab integer `id`; Bitbucket `account_id`; Backlog numeric `user.id`). GitLab marks token bots with `bot`; Bitbucket has the account type `app_user`; Backlog has no bot accounts.
- **Rate limits for polling:** GitLab.com 5,000 requests per hour on Free (more on paid tiers); Bitbucket Cloud 1,000 per hour for repository data; Backlog 600 reads per minute on paid plans and one tenth of that on Free.
- **Changing services:** Bitbucket Cloud removed App passwords, the issue tracker API and an option of the diff API in 2026, and changed OAuth client credentials. An adapter must expect more changes.

## 3. Ranking and effort (AC3)

| Rank | Host | Effort of an adapter | Why |
|---|---|---|---|
| 1 | **GitLab.com** (Premium or Ultimate project) | **L**, about 15–25 working days, plus about 5 days of live tests on a Premium and an Ultimate project | Almost everything has an API. The gaps (commit binding of approvals, review IDs, commit authors by e-mail, file lists cut at 1,000) have workarounds the platform can check itself. The token model is weaker (day-long project tokens, a long-lived creator token) but stays limited to one project |
| 2 | **Bitbucket Cloud** (Premium workspace) | **L**, about 15–25 working days | The read API is good, but there is no API for a token limited to one repository, approvals are not bound to a commit, merges are stopped only on Premium, and the service is changing its authentication fast |
| 3 | **Backlog** | **L**, about 12–18 working days, plus an adapter for an external CI | Seven methods need git on a clone, there is no CI, no approvals, no signed webhooks and no token limited to a repository. G7 would rest on comment commands and G6 on another system |

The estimates are from documentation only. The order follows how much of G6 and G7 the host itself can enforce, and how close its tokens are to the platform's rules (R028, R031).

## 4. What to check on a live account before X10

- **GitLab.com:** self-revoke of a project access token (`DELETE /personal_access_tokens/self`); whether a new approval updates the merge request's `updated_at` (for polling); the reviewer states the REST API returns; the SAST report artifact on Free and Premium; mapping commit e-mails to users.
- **Bitbucket Cloud:** the `merged` time and the activity order; whether approvals reset on push on Standard; the `diffstat` spec for two commits; `max_depth` of the source listing.
- **Backlog:** the status IDs of a closed and a merged pull request; the meaning of activity type 21; whether `branchCommit` is the current head; line positions of pull request comments; whether a user outside a protected branch's allow list can still press Merge.

## 5. Decisions (repository owner, 2026-10-21; QUESTIONS #511–#513)

1. **#511: the plan tier a project needs: Premium or higher.** The platform accepts a GitLab.com or Bitbucket Cloud project only when the host can stop a merge without approval (GitLab Premium, Bitbucket Premium) and the adapter has checked those settings by API; on lower tiers it refuses, because G7 would rest only on detection after the merge.
2. **#512: tokens weaker than the GitHub App: GitLab as a written exception, Bitbucket Cloud and Backlog refused for agent runs.** Accept GitLab project access tokens (one project, revoked by the platform after each run, a sweep for tokens left over, the creator token in OpenBao) as a written exception to the one-hour rule; refuse Bitbucket Cloud and Backlog for agent runs until each has a credential limited to one repository. A proxy that limits Git traffic to one repository is not chosen now (it would need its own ADR).
3. **#513: Backlog: no adapter for now.** If a client needs it, design it as "Backlog for pull requests and comments, an external CI for G6, comment commands for G7", which is a change of the G7 design (ADR-M41) and needs its own approval.

No adapter is built yet: X10 waits for a real project (QUESTIONS #361), and nothing in the platform changes. When X10 starts, it builds the GitLab.com adapter first, with these rules, and checks §4 on a live account.

## 6. Alternatives not chosen

| Alternative | Why not |
|---|---|
| Probe the APIs with test accounts | The owner chose documentation only for this spike (2026-10-21); §4 lists the checks for X10 |
| Self-managed GitLab and Bitbucket Data Center | Out of scope (owner, 2026-10-21); their APIs and tokens differ |
| One generic adapter over git alone | G6 and G7 need the host's reviews, CI and merge facts, which git does not have |

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-10-21 | Claude (task X09) | Result of the spike; decisions of §5 proposed (QUESTIONS #511–#513) |
| 1.0 | 2026-10-21 | Repository owner | Accepted, with the answers to QUESTIONS #511–#513 (the proposals of §5) |
