# ADR-M38. Gate G6: the push, the pull request and CI

| Item | Value |
|---|---|
| Status | **Proposed** (task C08; PR 1 in review: the push and the pull request; PR 2 follows: G6 reads CI) |
| Date | 2026-10-03 |
| Decided by | Harry (plan approved 2026-10-03: two PRs; QUESTIONS #155 A, #156, #157 A with a known limit, #158, #159) |
| Related | D-02 FR-13, FR-17, FR-18, FR-30, FR-33; D-02 §5 (version 1.2); D-03 sections 4, 6, 7.1, 8.2, 9, 10 (version 1.18); D-05 sections 6.2, 6.4 (version 1.23); D-08 C08 AC1–AC3; D-09 N2, N6; handbook Ch.14 §14.10, template T2; ADR-M23, ADR-M25 §2.1, ADR-M28, ADR-M29 §2.5, ADR-M30 §2.1, ADR-M33 §2.5, §2.9, ADR-M34 §2.8–§2.9; QUESTIONS #52, #57, #123, #124, #134, #155–#159 |

## 1. Context

G5 (C07) decides on a run's changes, but nothing leaves the platform yet: the runner keeps the run's diff as evidence, and an intent that passes G5 waits at G6. C08 makes the changes a pull request and lets G6 judge CI (D-08 C08).

Facts that shape the design:

- The sandbox never reaches the Git host; the runner clones and pushes (QUESTIONS #52, ADR-M25 §2.1). The push comes after G5, so changes that G5 refuses never leave the platform.
- What the sandbox reports is untrusted (ADR-M29 §2.5). The commit the agent made in the sandbox is not used: G5 judged the diff the runner computed outside the sandbox.
- The runner's clone is removed when the run ends (ADR-M34 §2.2), and the run's GitHub token can only read (ADR-M33 §2.5).
- The pilot repository is public (QUESTIONS #123): pull requests, comments and CI logs are public. The platform writes codes there, never client data.
- No secret and no client data in the Temporal history (ADR-M30 §2.1).

C08 has two pull requests:

- **PR 1** (this version): the push and the pull request (§2.1–§2.6), AC1 and AC3.
- **PR 2**: G6 reads CI (§2.7, planned): checks, retries, N2, security findings, the oversight matrix.

## 2. Decision

### 2.1. The round at G6

When the intent waits `in_gate G6` after G5 passed its run, the G6 step (`stepG6`, core) does, in this order:

1. Wait while the G5 HOTL block window is open (ADR-M34 §2.8): a person may still block G5, so nothing is pushed (`later_gate`, woken when the window closes).
2. The freeze check (`push`, then `open_pr`; ADR-M28 §2.4).
3. No push recorded for the run → the outcome `publish` / `push`. The workflow calls `preparePublish` (worker), then `publishRun` on the runner's task queue `sdlc-runner` (one attempt, heartbeats, 15 minutes), then `finishPublish` (worker).
4. Pushed, no pull request linked → `publish` / `open_pr`: `finishPublish` only.
5. Linked → the intent waits for CI (`ci_pending`); PR 2 evaluates it.

The database is the source of truth: the runner records the push as run events before it answers, and the intent holds the pull request. A workflow that starts again, or a lost activity result, finds its way. The worker steps G6 only when the publish deps are wired (`StepDeps.publish`); without them the intent waits at G6 as before.

### 2.2. The push: the diff G5 checked, one commit (QUESTIONS #155 A)

`publishRun` (runner, `workspace/publish.ts`):

1. Reads the run, its contract and its run events. The run must be `succeeded`; the contract's repository must be the project's and its branch the intent's own (`agent/<intent code>`), checked against the platform's records again; the stored diff (`diff_stored`, `evidence_items` kind `diff`) and the hash of its changed paths (`changes_checked.paths_sha256`) must exist. A run already pushed answers `pushed` again; a refused run stays refused.
2. Reads the stored diff back from the evidence store, only from the run's own path (`…/diffs/<tenant>/<intent>/<run>.patch`), and checks its SHA-256 against `diff_stored`. The runner's SeaweedFS identity `runner-evidence` gets a third action: `Read:evidence/diffs/*` (`openbao:bootstrap runner-evidence-credentials`; run it again once after the update). It still cannot read `proposals/`.
3. Unwraps the push token (§2.3) and clones the repository **without a working tree** (`cloneForPush`); the token is only in git's environment, as for the run's clone (ADR-M25 §2.11), and is checked to be nowhere in `.git`.
4. Builds the commit in a private index only: `read-tree <base_sha>`, `apply --cached --binary` of the diff, `write-tree`. No file of the change is ever written to the runner's disk, so symbolic links in the change are never followed (ADR-M33 §2.9). Git refuses paths outside the repository and `.git` paths in an index. The SHA-256 of the sorted changed paths (RFC 8785 JSON, exactly as `checkChangedPaths`) must equal `paths_sha256`; no change at all is `empty_diff`.
5. One commit on `base_sha`: author and committer `sdlc-agent <agent-<agent_id>@agents.sdlc.invalid>` (QUESTIONS #80), message `sdlc: <INT-…> run <run_id>`, both dates the run's `finished_at`. The same inputs make the same commit, so a repeated push is idempotent.
6. Reads `refs/heads/agent/INT-…` on the Git host (`ls-remote`, exact ref only: a ref that merely ends the same way neither hides nor blocks it). It must be absent, at `base_sha` (the next run of the intent, §2.6), or already at the commit; anything else is `branch_moved`. Push with the explicit refspec `<commit>:refs/heads/agent/INT-…`, no force, no hooks; the branch pattern is checked again. Read the branch again: it must show the commit (recomputed outside the sandbox, ADR-M29 §2.5).
7. Records the run event `branch_pushed` (`head_sha`, `parent_sha`, `diff_sha256`, `paths_sha256`) and sets `runs.head_sha` in one transaction (nothing is added when a concurrent attempt recorded the same commit first).

- **`runs.head_sha`** is "the last commit pushed" (D-05). The runner no longer writes there the HEAD the sandbox reported; that value stays in `agent_finished`. Migration 0017 lets a `succeeded` run get `head_sha` once (null → value, nothing else changed); every other change of a final run is still refused (`SDA05`).
- **Results:** `pushed`; `refused` (final, recorded as `publish_refused`: `not_succeeded`, `contract_invalid`, `changes_missing`, `diff_mismatch`, `empty_diff`, `diff_not_applicable`, `base_not_found`, `branch_moved`); `failed` (may pass, recorded as `publish_failed`: `evidence_unavailable`, `token_unavailable`, `clone_failed`, `remote_read_failed`, `push_rejected`, `record_failed`, `internal` for anything else, such as local git or the file system). The worker's side counts too: `token_failed` (the push token could not be issued or wrapped), `pr_failed` (the Git host failed) and `pr_head_differs`, `worker_failed` (a worker activity failed unexpectedly), `runner_lost`, and `publish_off` (a runner without publish settings). Every failure is counted, so the round never retries for ever (code review). Codes only: never a path, git's text or the token.
- **Known limit (#155):** one SeaweedFS identity reads the diffs of every tenant. This is acceptable for now: the runner already clones every tenant's code. Per-tenant identities come with B13 follow-ups or MVP+1.

### 2.3. Token scopes and lifetimes

| Token | Permissions | Issued by | Held by | Lifetime |
|---|---|---|---|---|
| Run token (C06) | `contents: read`, one repository | worker, `prepareRun` | runner (clone) | contract validity; wrapped likewise |
| Push token (C08) | `contents: write`, one repository | worker, `preparePublish` | runner, in memory only | wrapping token 10 minutes (`PUSH_TOKEN_WRAP_SECONDS`); the token itself GitHub's 1 hour |
| Pull request token (C08) | `pull_requests: write`, one repository | the adapter, inside `openPullRequest` | the worker, for one call | GitHub's 1 hour |

- The adapter's cached token stays read-only (plus comments). The sandbox never holds any of these.
- A `contents: write` token can push to any branch of the repository: GitHub cannot limit a token to one branch. The defences: the runner's refspec guard (`agent/INT-…` only), the short lifetime, and branch protection on the default branch with no bypass for anyone, the App included (N6, AC3; the live test checks it). Branch protection is therefore a precondition of every project, not an option (security review). Revoking the push token right after the push, and treating an already-used wrapping token as a security signal, come with C11 (token revocation).
- `preparePublish` issues the token only after it re-checked the step's conditions under the intent lock (the run is the latest and succeeded, nothing pushed or refused, attempts left, the block window closed, `push` not frozen).

### 2.4. The pull request

- `GitHostAdapter` gets two methods (D-03 §7.1): `openPullRequest(ref, { head, base, title, body })` (never a draft, `maintainer_can_modify: false`) and `findOpenPullRequest(ref, head, base)` (null, the one match, or a failure for more than one).
- `finishPublish` (worker) finds the open pull request from the agent branch into the default branch, or opens it. The pull request must show the pushed commit. GitHub updates a pull request's head shortly after a push, so a different head is a counted retry (`publish_failed`, `pr_head_differs`); a branch someone else moved keeps the difference, and G6 stops after `MAX_PUBLISH_ATTEMPTS` (`publish_attempts`). It links the pull request with `intents.linkPullRequest` (null → number, or the same number again; audit `intent.pr_linked` with the run, the number and the head) and records the notice `pr_opened` (Person B). The unique index of migration 0011 keeps one open intent per pull request.
- **One pull request per intent.** Later runs of the intent push to the same branch (§2.6), so the pull request updates by itself.
- **The body follows template T2**, from the message catalog (`pr.title`, `pr.body`), filled with codes only: the intent code, a link to its issue (`#n`, never "closes"), the run ID, the agent key, version and model, the autonomy level, the plan hash and the diff hash. "AI wrote most / all of this change" is ticked, and so is "Only files in the approved plan were changed" (G5 checked it). The "human reviewed every file" box is never ticked by the platform (T2 rule). Never the intent's title or description, the paths, or any text from the agent (QUESTIONS #123).
- A Git host error while finding or opening counts as a failed attempt (`publish_failed`, `pr_failed`).

### 2.5. When the push stops (QUESTIONS #156)

- A refusal of the runner, or `MAX_PUBLISH_ATTEMPTS` (3) failed attempts of the push and the pull request together, stops G6: the intent is `paused` at G6 with a `technical` escalation (trigger `unusual_behaviour`) at `run.failed_run_escalation` (rule M20: `pause` or higher). Audit `gate.g6_publish_stopped` (run, reason code, escalation); notice `g6_publish_stopped`. The packet is bound to the run's diff (`subject_kind` `diff`, `subject_sha256` = `diff_stored.sha256`); the run's `triggered_by` is a producer and never decides (FR-18).
- A lost runner (the activity fails or times out) counts as a failed attempt: `abandonPublish` records `publish_failed` (`runner_lost`, or `worker_failed` for a worker activity) unless the round is done or refused. The workflow waits a minute after a failed attempt.
- A runner that lost its heartbeat may still finish the push later. The state stays consistent (a recorded push wins over the failures), but G6 may already have stopped: the decision on the escalation then sees a pushed branch, and `resume` continues from it (§2.6).
- A push that landed but could not be recorded (`record_failed`) is found again by the next attempt: the commit is the same, so the runner sees the branch at the commit and records it.
- The decision (`stepPausedG6`), re-checked just before acting (FR-17): `resume` → `in_gate G4` (a new run; after `branch_moved` a person first restores or deletes the branch); `modify` or `roll_back` → `in_gate G3`, HITL from then on, the G3 approvals in force voided (notice `g6_returned`); `terminate` → `cancelled`. An escalation closed without a decision is raised again, so a paused intent always has one.
- A pull request a person closed, or a later push by someone else, is found by G6 in PR 2 (CI) and handled the same way.

### 2.6. The next run continues the pull request (QUESTIONS #134)

Once a run of the intent was pushed, G4 takes as the next run's `base_sha` the commit the platform last pushed (`lastPushedHead`, from `branch_pushed`), not the head of the default branch. The run's diff is then the change on top of what is already in the pull request, G5 checks only that change, and its push is a fast-forward. The recorded commit, not the branch's live head: a commit someone else pushed is never built on (the next push is refused, `branch_moved`). Before any push, the default branch head is used, as before (QUESTIONS #109).

### 2.7. G6 reads CI (PR 2, planned)

Decided in the plan, built in PR 2:

- **Facts** read before the intent lock: `getPullRequest` and `getCheckStatus(head_sha)`. The step never trusts event content. The poller's `check_completed` events wake the intent of the pull request; the reconcile loop is the backstop; the only new timer is the CI timeout.
- **Checks** (QUESTIONS #159): project config `verification.required_checks` (empty: every check on the commit; the pilot: `[ci-ok]`). `success`, `neutral`, `skipped` pass; `failure`, `timed_out`, `startup_failure`, `error` fail; `cancelled`, `stale`, `action_required`, a missing check or no check at all are pending. Pending after `verification.ci_timeout_minutes` (default 60) → `paused` and a `technical` escalation; a timeout uses no retry.
- **Fail** with retries left (`run.g6_ci_retries`) → a new run after G4 from the pushed commit; the retry run gets a fixed instruction from the catalog, never CI logs (QUESTIONS #158). No retries left → back to G3, HITL (N2, FR-13).
- **Pass** by the matrix: AUDIT and HOTL a system `pass` (HOTL with a block window), HITL Person B. The run's `triggered_by` never approves.
- **Security findings** (QUESTIONS #157 A): GitHub code-scanning alerts on the pull request, counted per severity (counts only stored; App permission `security_events: read`). At or above `oversight.g6_security_findings.min_severity` → HITL; critical → a `security` escalation. Findings unknown → HITL (fail closed). **Known limit:** GitHub code scanning is free only for public repositories; on a private repository without GitHub Advanced Security the findings are unknown, so G6 is HITL every time. MVP+1 option: read the Semgrep and Trivy results (SARIF) from CI artifacts. The pilot repository gets a small CI change that uploads SARIF.

### 2.8. Where the rules live

| Rule | Where |
|---|---|
| Push only after G5 and its block window, the check order, fail closed (hash checks, `branch_moved`), no force | Code (design) |
| Push attempts (3), the retry pause (1 minute), the wrap lifetime of the push token (10 minutes) | Code (design): `MAX_PUBLISH_ATTEMPTS`, `RUN_ACTIVITY_RETRY_MS`, `PUSH_TOKEN_WRAP_SECONDS` |
| The escalation's severity and level when the push stops | Project config `run.failed_run_escalation` (rule M20) |
| The PR title and body | Message catalog `pr.title`, `pr.body`, `pr.issue` |
| The runner's evidence actions | `platform/deploy/openbao/bootstrap.sh` `runner-evidence-credentials` |

## 3. Alternatives considered

- **Push from the sandbox's commit** (the agent's `commitWork`): what G5 judged is the diff, not that commit; the agent controls the sandbox's `.git`. Refused (ADR-M29 §2.5).
- **Keep the runner's clone until G5 decides** (QUESTIONS #155 B): a clone per waiting intent on the runner's disk, lost on a restart. Refused.
- **Push before G5** (QUESTIONS #155 C): changes G5 would refuse would be public on the Git host. Refused (QUESTIONS #52).
- **A working-tree checkout and `git apply`:** writes the agent's files to the runner's disk and follows links unless hardened; the index-only build needs neither. Refused.
- **Force-push the agent branch:** would hide a change someone else made. Refused: `branch_moved` goes to a person.
- **The worker pushes** (it holds the App key): the worker has no git workspace and no Git egress by design; the runner does (ADR-M25). Refused.

## 4. Consequences

- The GitHub App needs **Contents: read and write** and **Pull requests: read and write** (ADR-M23 §2.2, GETTING-STARTED Step 11); PR 2 adds **Code scanning alerts: read**. The installation must accept new permissions.
- `runner-evidence-credentials` must run again once (the new read action).
- A push takes one runner activity slot for a short time (the slot pool is the sandbox limit).
- The live test with the test App (opt-in, never in CI) checks AC3 (N6) on the real pilot repository and the review case of QUESTIONS #57.
- A pull request opened by the GitHub App starts the repository's CI like any pull request; on GitHub, its author is the App, so Person B can approve it (QUESTIONS #124).

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-10-03 | Claude (task C08, PR 1), approved by Harry | §2.1–§2.6 the push and the pull request; §2.7 PR 2 as planned; QUESTIONS #155–#159. After the code and security reviews: every failure is counted, a different PR head is a counted retry, the contract and the diff path are checked again, exact ref match |
