# ADR-M41. Gate G7: review and merge

| Item | Value |
|---|---|
| Status | **Proposed** (task E01, for review) |
| Date | 2026-10-03 |
| Decided by | Harry (plan approved 2026-10-03, with answers to QUESTIONS #175–#179) |
| Related | D-08 task E01 (AC1–AC5); D-02 FR-11, FR-12, FR-16, FR-17, §5; D-03 §6, §6.1, §6.2, §7.1 (version 1.21); D-05 §5, §6.2, §6.4 (version 1.26); handbook Ch.15 §15.4, §15.5, §15.10; ADR-M07, ADR-M20, ADR-M23, ADR-M27, ADR-M30, ADR-M38; QUESTIONS #16, #45, #124, #134, #175–#179 |

## 1. Context

Since C08 the platform pushes the run's checked changes to `agent/INT-…`, opens the pull request and reads CI at G6. After G6 the intent waits `in_gate G7`, which nothing handled.

G7 is the merge into the protected branch. It is HITL at every risk tier (codes table §4, rule M2), Person B approves, the producer never counts (FR-11), and some changes need a second approver (FR-16). Approvals are bound to the reviewed commit (FR-17, handbook Ch.15 §15.4). A person merges; the platform never does.

ADR-M07 says G7 relies on pull request approvals on GitHub. The pilot repository requires 0 approvals until Person B has an account (QUESTIONS #124), so the platform cannot rely on branch protection's count: it counts the approvals itself.

E01 is two pull requests. PR 1 (this ADR's §2.1–§2.6): the reviews, the producers, dual approval, the merge, the escalations. PR 2 (§2.7): a request for changes starts a new run with the reviewer's feedback.

## 2. Decision

### 2.1. G7 reads the pull request before the lock

- When the intent waits at G7, the step reads, before the intent lock (as at G4 and G6): the pull request (state, head, merge commit, `merged_by`), the latest review decision of each reviewer (`getReviews`), and the accounts that authored its commits (`getCommitAuthors`).
- Under the lock the step records the reading as the run event `g7_checked` when it changed: codes, counts and a hash of the review decisions (IDs, states, commits). Never a login, a review text or a commit message.
- The Git host cannot be read → people's rejections and requests for changes are still handled; nothing else moves (`git_host_unavailable`, retried after a minute).

### 2.2. Waking

- The poller's reviews stream now also returns closed pull requests: a new `GitEvent` kind, `pull_request_closed` (merged or not; key `p<number>` in the cursor). The `pull_request` webhook with `closed` maps to the same event (ADR-M11).
- `review_submitted` and `pull_request_closed` wake the intent of the pull request. They are triggers only: G7 reads the pull request again. The reconcile loop covers a missed wake.

### 2.3. The G7 input

The G7 input hash binds every G7 decision and escalation (FR-17): the run, its pull request, the commit the platform pushed (`branch_pushed`), and the change flags of the plan G3 approved (dual approval). A request for changes leads to another run (PR 2), so another input: the earlier approvals no longer count.

### 2.4. Reviews are the approvals (QUESTIONS #175, #176)

- A review counts only when it reviewed the **commit the platform pushed**. Each review is recorded once, with a `git_event_receipts` row under its event ID (`github:review:<id>`, the outbox and idempotency of comment commands, ADR-M27):
  - `approved` → an `approve` decision through the registry (source `github_review`, `reason_ref` = the review URL). The policy engine checks the gate's roles, the producers and dual approval (`canApprove`).
  - `changes_requested` → a `request_changes` decision (reason code `other`, the review URL as `reason_ref`), only from a holder of the gate's role who is not a producer.
  - A bot → `ignored_bot`, no reply. An account not linked to an active user → `user_not_linked`. A refusal → `refused`. A person gets one reply comment on the pull request, with catalog codes only (the pilot repository is public).
- An approval whose review was dismissed, replaced by a later decision of the same reviewer, or gone, is voided (`input_mismatch`).
- Every approval still valid for the G7 input counts, also after a stay at `paused G7` (the input already binds the run, the pushed head and the flags). An approval that expired (`oversight.approval_expiry`) is voided, and its review is not recorded again: the reviewer submits a new review.
- `/approve G7` by a comment or the CLI is refused (`g7_use_pr_review`). `/reject G7` and `/request-changes G7` are accepted; a producer may not send them.
- **Producers at G7** (AC2): the intent's creator (QUESTIONS #16), the person who allowed each run (`triggered_by`), the people who submitted plan files (B09), and the platform users who authored a commit of the pull request (numeric account ID). Bots and agents are never people.
- **Approvals needed** (AC3): HITL; the matrix count, Person B and the second approver for a plan flagged with a `DUAL_APPROVAL_G7` flag or at Critical risk (two different people, one per role).

### 2.5. The merge (AC5, QUESTIONS #177)

- G7 passes only when the pull request is **merged** with the pushed commit as its head, by a **person** (an active platform user linked by numeric account ID who is not a producer), after enough valid approvals, recorded from reviews submitted **before the merge**. Then, after the G6 block window and the freeze check: run event `pr_merged` (pull request, head, merge commit), audit `intent.pr_merged`, notice `merged`, and `in_gate G8` (E03).
- Approvals complete, not merged → the intent waits (`g7_merge`); Person B is told once.
- Anything else stops G7: the intent is paused at G7, the audit event `gate.g7_check_failed` names the check, and an escalation bound to the G7 input is raised at `run.failed_run_escalation` (rule M20: `pause` or higher):

| Check | Escalation | Gate decision |
|---|---|---|
| `pr_closed` (closed, not merged) | `technical` | — |
| `head_changed` (open, another commit than the platform pushed) | `technical` | — |
| `merged_before_approval` | `security` | system `fail merged_before_approval` |
| `merged_other_head` (merged with another commit) | `security` | system `fail merged_before_approval` |
| `merged_by_producer` (a bot, a producer, an unknown or unlinked account) | `security` | system `fail merged_before_approval` |

- The escalation's decision, re-checked just before acting (FR-17):
  - `resume` → back to `in_gate G7`, where G7 reads the pull request again (a person reopens it or restores the branch first). After a merge escalation, the people who decide accept the early merge: late approvals of the merged commit count, and the merger check is waived for this input.
  - `modify` or `roll_back` → back to G3, HITL from then on, G3 approvals voided. A person reverts a merged change on the default branch: the platform never writes to it.
  - `terminate` → `cancelled`.
  - Closed without a decision, or the G7 input changed → back to G7, which reads again (and raises a new escalation if the problem is still there).

### 2.6. A rejection, a request for changes, the deadline (QUESTIONS #178)

- `/reject G7` → back to **G3**, HITL from then on (as G6 with no retry left, ADR-M38 §2.7); the G3 approvals in force are voided. The pull request stays open; the next run continues from the pushed commit (QUESTIONS #134; no force-push). D-03 §6 and diagram D12 show G7 → G3.
- A request for changes (a review or a command) holds G7 in PR 1 (`g7_changes_requested`, notice to Person A). A request from a review holds only while that review is still its reviewer's latest decision on the pushed commit: a dismissed review, or a later approval by the same person, releases G7. While a request holds, G7 never passes, even if the pull request is merged.
- The gate deadline (`oversight.hitl_gate_deadline`, FR-12) raises one overdue escalation per clock start (subject `g7_input`, ADR-M30 §2.9), until the merge.

### 2.7. PR 2: a request for changes starts a new run (QUESTIONS #179)

- The valid `request_changes` decision moves the intent to G4: a new run from the pushed commit, like a G6 retry, with no retry limit (each round needs a person; the intent budget caps the cost).
- The runner reads the reviewer's feedback from GitHub with its own `pull_requests: read` token, at run start, into the agent's prompt, in memory only: never in Temporal, logs or tables; the length is capped.
- The runner reads **only the review recorded as that decision**, found by its ID through the decision's receipt; never "the latest changes_requested review" (anyone can review a public repository).

### 2.8. Catalog and data

- Migration `0019-gate-g7`: the reason code `merged_before_approval`. A dismissed or replaced review, and a head that changed, use `input_mismatch`.
- Run events `g7_checked` and `pr_merged`; audit actions `gate.g7_check_failed` and `intent.pr_merged`.
- Notice kinds `g7_review_needed`, `g7_changes_requested`, `g7_merge_ready`, `g7_escalated`, `g7_returned`, `g7_resumed`, `merged`; `terminated` at G7 has its own text.
- Escalation subject kind `g7_input`. Wait reasons `g7_decision`, `g7_merge`, `g7_changes_requested`, `g7_review`.
- `GitHostAdapter`: `getReviews`, `getCommitAuthors` (sixteen methods); `PullRequestInfo.mergedBy`; `GitEvent` kind `pull_request_closed`. The App's existing permissions are enough (Pull requests, Contents: read).
- Command refusal `g7_use_pr_review` (API 422, comment reply).

## 3. Consequences

- G7 does not depend on branch protection's approval count: the pilot works with one human account today, and stays correct when Person B and `require_last_push_approval` arrive (#124).
- An early merge is never silent: it stops the intent with a `security` escalation, and G8 waits for a person's decision.
- Every review gets a receipt row (a small table growth per pull request).
- A request for changes leaves the intent waiting at G7 until PR 2.

## 4. Not done here

- The platform never merges, closes or reopens a pull request, and never reverts the default branch.
- The optional rule "the G7 approver is not the G3 approver" (D-05 `runs.triggered_by` note) is not configured.
- Commit authors are producers only for approvals recorded from reviews; a command's producers come from the database (creator, runs, plan submitters).
- Reviews from forks and the GitLab adapter: later (MVP+1).
