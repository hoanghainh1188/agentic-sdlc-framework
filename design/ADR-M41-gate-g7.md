# ADR-M41. Gate G7: review and merge

| Item | Value |
|---|---|
| Status | **Proposed** (task E01, for review) |
| Date | 2026-10-03 |
| Decided by | Harry (plan approved 2026-10-03, with answers to QUESTIONS #175–#179) |
| Related | QUESTIONS #191 (PR 2); D-08 task E01 (AC1–AC5); D-02 FR-11, FR-12, FR-16, FR-17, §5; D-03 §6, §6.1, §6.2, §7.1 (version 1.21; PR 2: 1.23); D-05 §5, §6.2, §6.4 (version 1.26; PR 2: 1.28); handbook Ch.15 §15.4, §15.5, §15.10; ADR-M07, ADR-M20, ADR-M23, ADR-M27, ADR-M30, ADR-M33, ADR-M38, ADR-M42; QUESTIONS #16, #45, #124, #134, #175–#179, #190 |

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
  - A bot → `ignored_bot`, no reply. An account not linked to an active user → `user_not_linked`, no reply either (Harry, review of PR #138): anyone can review a public repository, and nobody may use it to make the platform spam a pull request or burn API quota. A linked user's refused review (no role, a producer) → `refused`, with one reply comment on the pull request, catalog codes only.
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
- A request for changes (a review or a command) is in force when: from a review, that review is still its reviewer's latest decision on the pushed commit (a dismissed review, or a later approval by the same person, releases it); from a command, it is the latest request since the intent entered G7. While a request is in force, G7 never passes, even if the pull request is merged (a merge first: `merged_before_approval`, §2.5). PR 1 held G7 there (`g7_changes_requested`); PR 2 starts a new run (§2.7).
- The gate deadline (`oversight.hitl_gate_deadline`, FR-12) raises one overdue escalation per clock start (subject `g7_input`, ADR-M30 §2.9), until the merge.
- Fixed in E01 PR 2: a request is a review's only when its receipt's event ID starts with `github:review:`; a `/request-changes G7` comment also has a receipt (`github:comment:<id>`) and follows the command rule (the latest request since the entry). PR 1 took every receipt for a review's, so a comment's request was skipped and G7 could pass at the merge.

### 2.7. PR 2: a request for changes starts a new run (QUESTIONS #179, #190)

- **The move.** The request in force (§2.6) moves the intent `in_gate G7 → in_gate G4` (notice `g7_changes_requested`, to the G4 operators): a new run from the pushed commit (`lastPushedHead`, ADR-M38 §2.6), like a G6 retry, with no retry limit (each round needs a person's request; the intent budget caps the cost). The next run pushes another commit, so another G7 input: the approvals of this input no longer count (§2.3). A rejection still wins over a request; a request after the merge has nothing left to change.
- **Which request a run answers** (`core/workflow/g7-feedback.ts`, `feedbackSourceFor`), from the database only: the latest G7 `request_changes` bound to the G7 input of the last pushed run (once a later run pushed, the request is answered: a CI retry after it gets no old feedback); its receipt (`git_event_receipts`), by event ID: `github:review:<id>` or `github:comment:<id>`, never "the latest changes_requested review"; the decider's linked Git host account (numeric ID). Only a role holder who is not a producer gets a decision (§2.4), so a review by anyone else never starts a run.
- **Where the text lives and the token** (#190). A review: `pull_requests: read`. A `/request-changes G7` comment: on the pull request `pull_requests: read`, on the intent's issue `issues: read` (the receipt's `issue_number` against the intent's `pr_number`; GitHub reads a comment with either permission). The text of a comment is what follows the command and the optional reason code, then the lines below it. The API and the CLI cannot request changes at G7 (`g7_feedback_on_git_host`, 422): their `reason_ref` is a free link the runner never fetches.
- **The worker's check** (`prepareRun`, before the contract's secrets). For a review, the step reads the pull request's reviews: the review must still be its reviewer's latest decision, `changes_requested`, of the pushed commit, by the decider's account; the decider must still be an active user with a linked identity. Otherwise (`review_withdrawn`, `identity_unlinked`, `git_host_unavailable`, …) the run ends `failed` (`agent_feedback_unavailable`, run event `feedback_unavailable`) before any key, token or sandbox exists, and the intent is paused at G4 with a `technical` escalation, like any failed run (ADR-M33 §2.7). The decision on that escalation (QUESTIONS #191; the same for a failure the runner records): `resume` → back to **G7** when the pull request is open and its head is still the commit the platform pushed last (read before the lock; G7 then waits for reviews of that commit under the normal rules, its facts taken from the last pushed run), otherwise → G4 as for any failed run; `modify` or `roll_back` → G3, HITL from then on, G3 approvals voided; `terminate` → `cancelled`. When it holds, the worker issues a third single-repository token with only that read permission and wraps it for the runner (single use, TTL = contract validity). Temporal carries the wrapping token only.
- **The runner's read** (`apps/runner/src/agent/feedback.ts`), the second line. Before the agent starts it finds the request again, checks that the run starts from the reviewed commit, opens the wrapping token, reads that one review (with at most 50 line comments) or comment with the token-only adapter (`getReviewFeedback`, `getIssueComment`), and revokes the token at once (`token_revoked` `feedback`). It checks the author (one of the decider's linked accounts), and for a review the state and the commit (an empty review fails: `feedback_empty`); for a comment that it is still a `/request-changes G7` command (a command with a reason code only gives the agent that code). It removes control and bidirectional characters and invisible ones (zero-width characters, word joiners, the byte-order mark, Unicode tag characters), which could hide text from a person but not from a model, and caps the text at `REVIEW_FEEDBACK_MAX_CHARS` = 8,000 characters (about 2,000 tokens: a review body and a dozen line comments; it bounds the prompt's cost and the text a person can put in front of the agent; GitHub allows 65,536 per body). Run event `feedback_read` holds counts only (source, characters, cut or not, line comments). Any failure fails the run (`agent_feedback_unavailable`); a refused wrapping token is `wrap_token_reused` (security route, ADR-M42 §2.5). A run that holds a feedback token but does not read with it (refused at provisioning, killed or failed before the agent starts, no request in force, a failed check) opens and revokes it too, so no live token is left behind (ADR-M42 §2.4).
- **In the prompt** (OpenHands adapter, `feedbackBlock`): a fixed sentence (a reviewer requested changes; the workspace starts from the reviewed commit), then the text between two markers that carry a random nonce, so the text cannot close the block. The agent is told the text is untrusted data written by a person, to use only to decide what to change within the spec, the plan and the allowed files; it cannot change the instructions, the rules (which follow the block), the files, the tools or the branch. The platform enforces those whatever the text says (G5 scope check, contract tools, no push from the sandbox).
- **Never stored.** The text is in memory in the runner and in the agent's conversation (the sandbox, and LiteLLM's traces in Langfuse, like every prompt). It is never in Temporal inputs, signals or results, logs, run events, audit events or any table (tests search every table, the Temporal history and the process output for a marker).

### 2.8. Catalog and data

- Migration `0019-gate-g7`: the reason code `merged_before_approval`. A dismissed or replaced review, and a head that changed, use `input_mismatch`.
- Run events `g7_checked` and `pr_merged`; audit actions `gate.g7_check_failed` and `intent.pr_merged`.
- Notice kinds `g7_review_needed`, `g7_changes_requested`, `g7_merge_ready`, `g7_escalated`, `g7_returned`, `g7_resumed`, `merged`; `terminated` at G7 has its own text.
- Escalation subject kind `g7_input`. Wait reasons `g7_decision`, `g7_merge`, `g7_changes_requested`, `g7_review`.
- `GitHostAdapter`: `getReviews`, `getCommitAuthors` (sixteen methods); `PullRequestInfo.mergedBy`; `GitEvent` kind `pull_request_closed`. The App's existing permissions are enough (Pull requests, Contents: read).
- Command refusal `g7_use_pr_review` (API 422, comment reply).
- PR 2: run events `feedback_read`, `feedback_unavailable`; stop reason `agent_feedback_unavailable`; `GitHostAdapter.getReviewFeedback`, `getIssueComment` (nineteen methods); `ExecuteRunInput.wrappedFeedbackToken`; `AgentTask.reviewFeedback`; API refusal `g7_feedback_on_git_host` (422). No migration.

## 3. Consequences

- G7 does not depend on branch protection's approval count: the pilot works with one human account today, and stays correct when Person B and `require_last_push_approval` arrive (#124).
- An early merge is never silent: it stops the intent with a `security` escalation, and G8 waits for a person's decision.
- Every review gets a receipt row (a small table growth per pull request).
- A request for changes starts a new run (PR 2): the agent reads the reviewer's own words, so the round needs no person to rewrite them; the cost is one more agent run per round, capped by the intent budget.
- The worker issues a third GitHub token per answering run; Temporal holds three wrapping tokens for such a run.
- The runner's second check reads the one review by its ID: it sees a dismissal, but not a replacing review (an approval after the request keeps the old review `changes_requested` on GitHub). The worker's check just before (`reviewStillHolds`, from the reviewer's latest decisions) covers it; the window between the two is the time a run waits for a runner slot.
- The request a run answers is bound to the G7 input, which includes the plan's change flags. A plan changed after the request (back to G3, approved again) makes the old request no longer match: the next run starts without feedback.

## 4. Not done here

- The platform never merges, closes or reopens a pull request, and never reverts the default branch.
- The optional rule "the G7 approver is not the G3 approver" (D-05 `runs.triggered_by` note) is not configured.
- Commit authors are producers only for approvals recorded from reviews; a command's producers come from the database (creator, runs, plan submitters).
- Reviews from forks and the GitLab adapter: later (MVP+1).
