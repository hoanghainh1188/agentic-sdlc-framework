# Chapter 19. Approval queues and avoiding review bottlenecks

> Readers: **Person A, Person B, PM/BrSE** · Reading time: about 10 minutes
> Status: **Draft 0.1**, awaiting Harry's comments.

---

## 19.1. Purpose

- Keep human approvals **meaningful** without letting them stop all work.
- When agents produce more, the bottleneck moves to review. This chapter keeps that queue short.

## 19.2. Scope

All HITL gates and escalations (codes table §4; Chapter 6).

---

## 19.3. Principles

1. **Only block what needs blocking.** Low-risk, reversible work does not wait for a person (HOTL or AUDIT).
2. **Waiting must not stop independent work.** While an approval is pending, the agent continues with work that does not depend on it.
3. **An approval is not a blank cheque.** It is bound to the exact version, scope, environment and expiry.
4. **The queue is measured like any other system.**

---

## 19.4. Blocking and deferred approvals

| Type | Used for | What the agent does while waiting |
|---|---|---|
| **Blocking** | Deleting data, production deploys, merging security changes, payments, access changes, hard-to-reverse migrations | Stops **before** the protected action |
| **Deferred** | Low-risk or reversible steps: extra tests, documentation, sandbox improvements, draft pull requests | The step is "parked"; independent work continues |

Example:

```text
                     ┌─ waiting for approval ─→ deploy
agent plan ──────────┤
                     ├─ run independent tests
                     ├─ update documentation
                     └─ prepare the rollback plan
```

Only the protected action is locked. Evidence, tests and the rollback plan are ready when the reviewer answers.

---

## 19.5. Keeping the queue short

| Practice | How |
|---|---|
| **Route to the right person** | Decide the approver **before** the request is created: by change type, repository, risk tier, ownership, availability and conflicts of interest. Finding a reviewer must not become a new bottleneck |
| **One decision packet, not raw logs** | Goal, scope, diff or action summary, risk, test and security results, expected effect, rollback plan, and **what changed since the last review** (Chapter 4 §4.5) |
| **Batch similar low-risk requests** | Group similar items into one decision, to reduce context switching |
| **Deadlines and backups** | Every HITL request has a deadline, a backup reviewer and an escalation path (Chapter 6 §6.5) |
| **Share Person B's load** | A backup Person B per project; rotation for HOTL monitoring (Chapter 5) |
| **Fix the cause of rejections** | Many rejections usually mean unclear specs or plans, not bad reviewers |

**No answer never means yes.** Our rule stays: items on the pre-approved safe list may continue; everything else stays frozen until a person decides (Chapter 6 §6.5).

---

## 19.6. Checking an approval is still valid

Just before the protected action runs, check that it matches what was approved:

| Bound to | Example |
|---|---|
| Version or hash of the proposal | Plan v3, spec hash |
| Exact commit or artifact | Commit `abc123`, image digest |
| Environment | Staging, production |
| Scope | Services, files, data affected |
| Expiry | Valid until a given time |

If anything differs → **cancel and ask again**. Three rules always hold:
1. No valid approval → no protected action.
2. A pending approval does not block independent work.
3. What runs is exactly what was approved, or it needs a new approval.

---

## 19.7. Metrics

| Metric | Meaning | Warning |
|---|---|---|
| Approval waiting time (median, 95th percentile) | How fast reviewers respond | Median first review above 2 hours (Chapter 8 §8.7) |
| Queue depth | Requests waiting | Growing week after week |
| Timeout rate | Requests not handled within SLA | Any, for High and Critical |
| Escalation rate | Requests passed to the next level | Rising |
| Rejection rate | Quality of proposals and specs | Rising |
| Rework rounds before approval | Clarity of what is asked | Rising |

---

## 19.8. Before the platform

- Use GitHub review requests and CODEOWNERS for routing; labels for risk tier.
- Person A writes the decision packet in the PR description (template T2).
- The weekly report (T8) lists items waiting longer than their deadline.

---

## 19.8b. Using the platform: gate commands in comments

> **Platform usage section, owned by Claude Code** (CLAUDE.md "Documentation rules"). Written with task B06, 2026-09-27, updated with task B07 (the gate workflow and status comments; session 2: HOTL gates, block windows, gate deadlines) and task B12 (the project AI record before G1), and kept in line with the platform code (`design/ADR-M27-github-poller.md`, `design/ADR-M30-intent-workflow.md`, `design/ADR-M32-project-ai-record.md`). The rest of this chapter is Draft 0.1 and is written outside Claude Code.

You can decide a gate by writing a comment on the GitHub issue or pull request of the intent. The platform reads new comments about every 30 seconds (project setting `github.poll_interval_seconds`). The CLI does the same through the API: `sdlc gate approve|reject|request-changes <gate> <intent>` (§19.8c).

**Commands.** Write the command on the **first line of a new comment**:

| Command | Records |
|---|---|
| `/approve G3` | An approval of G3. Nothing may follow the gate on that line |
| `/reject G3 <reason>` | A rejection. The reason is required |
| `/request-changes G3 <reason>` | A request for changes. The reason is required |

- Gates G1, G2 and G3 can be decided by comment; G4 and G5 when they wait for a person (Chapter 13 §13.10); G6 when CI passed and it waits for Person B, or within its block window (Chapter 14 §14.10.2). G7 and G8 come later.
- The reason may start with a reason code: `spec_unclear`, `tests_insufficient`, `security_finding`, `out_of_scope`, `policy_denied`, `budget_exceeded`, `ci_failed`, `ai_record_missing`, `data_class_not_allowed`, `expired`, `input_mismatch`, `scope_mismatch`, `other`. A code other than `other` may stand alone: `/reject G2 spec_unclear` is accepted. `other` alone is not a reason: `/reject G2 other` without text is refused. Without a code, the platform records `other`, and you must write a sentence. Example: `/reject G2 spec_unclear AC2 does not say which warehouse`.
- The reason text stays in your comment. The platform stores only the reason code and a link to the comment, because its records are kept for years and can never be edited. Write the reason so that it can stay on GitHub, and do not put personal or client data in it.
- Only new comments count. **Editing a comment never changes a decision.** To change your mind, write a new comment.
- Text on later lines, quoted text (`> /approve G3`) and commands inside code blocks are not read.
- `/kill` stops the intent's agent run with the kill switch: Chapter 18 §18.8d.

**Who may decide.**

- Your GitHub account must be linked to your platform user. The link uses the numeric account ID, so renaming your GitHub login does not break it. Ask the platform admin to link it.
- You need the gate's role on the project, for example Person A for G1 and Person B for G3 (codes table §4). The producer of a change never approves it.
- Bots and automation accounts never decide.
- The intent must be linked to the issue or pull request. One issue (or pull request) has at most one open intent; the platform refuses a second one until the first is closed.
- **You can decide only the gate the intent is waiting at.** The last status comment shows it. A command for another gate gets a reply, and nothing is recorded. One exception: a gate the platform passed on HOTL can still be rejected or sent back during its block window (below).

**Answers.**

- **A successful command gets no reply of its own.** The platform posts a **status comment** on the issue when the intent's status changes (FR-22). It confirms your decision: it names who decided and mentions the people who act next.

  | Status comment | When |
  |---|---|
  | Submitted, waits at G1 | The intent was created, and the project AI record allows its data class |
  | Cannot enter G1 yet (reason code) | The project has no AI record (`ai_record_missing`), or the record does not allow the intent's data class (`data_class_not_allowed`). See "The project AI record" below |
  | G*n* approved, waits at the next gate | The gate had the approvals it needs, bound to the current spec or plan |
  | Rejected at G*n* (reason code) | Someone rejected the gate; the intent is closed |
  | Changes requested at G*n* (reason code) | Someone asked for changes; the intent stays at the gate |
  | The platform passed G*n* (HOTL), waits at the next gate | The gate's conditions hold at Low risk; the comment shows until when you can block it |
  | Back at G*n* | Someone requested changes at a passed gate during its block window; the intent went back |

- The status comment comes a little later than your command: the platform moves the intent, then posts on the next poll (about 30 seconds).
- **A request for changes** keeps the intent at the gate. Approvals written before it no longer count. Update the gate's input (a new spec version for G2, a new plan for G3), then approve again; an approval of an older spec or plan no longer counts either.
- **No gate passes by silence.** At a HITL gate the intent waits until a person with the gate's role approves. HOTL gates pass only when their conditions hold, and you can still block them (below). While an escalation freezes the intent, it does not move on, even with the approvals; it continues once the escalation is decided (Chapter 18 §18.8b).
- A command that the platform cannot read or refuses gets a reply that says why and shows the syntax. Nothing is recorded in that case: fix the command and write a new comment.
- If the platform itself fails while handling your command, it tries again on the next polls. After a few failed attempts it gives up and replies that it could not record the command. Nothing is recorded; write the command again later, and tell the platform operator.

**HOTL gates (Low risk: G2 and G3 by default).** The project setting `oversight.matrix` says which gates are HOTL at which risk tier.

- The platform **passes** the gate by itself when its conditions hold:
  - G2: a spec is linked to the intent;
  - G3: a plan with at least one planned file is submitted, and no change flag forces HITL (for example `migration`; Chapter 12).
- It posts a status comment that mentions the people of the gate (G2: Person A; G3: Person B) and says **until when you can block it**. This is the **block window**: 4 working hours by default (project setting `oversight.hotl_block_window`, counted on the project's working calendar).
- **To block a passed gate**, write within the window `/request-changes G2 <reason>` or `/reject G2 <reason>`, even though the intent already waits at a later gate. You need the gate's role.
  - A request for changes takes the intent **back** to that gate. Approvals given at the later gates no longer count; they must be given again when the intent gets there.
  - A rejection closes the intent.
  - After the window, the gate can no longer be blocked. `/approve` of a passed gate is always refused: there is nothing to approve.
- After a request for changes, the platform does **not** pass the gate again with the same spec or plan. Link a new spec or submit a new plan, or approve the gate yourself with `/approve G2`.
- `/approve` at a HOTL gate always passes it at once, and then there is no block window: a person decided.
- **No agent run starts while a block window is open** (task C06): a person may still take the intent back.

**Deadlines of the gates (FR-12).**

- A gate that waits for a person has a deadline: 1 working day by default (project setting `oversight.hitl_gate_deadline`). The clock starts when the intent enters the gate, and starts again at each request for changes. It also runs while the gate waits for its spec or plan.
- When the deadline passes, the platform raises **one escalation** (Chapter 18 §18.8b): Medium, level Notify by default (project setting `oversight.gate_overdue`). It goes to Person A when Person A holds the gate's role (G1, G2), otherwise to Person B (G3).
- When the gate is decided (approved, rejected, changes requested, passed), the platform closes that escalation itself. You do not need to `/ack` or `/decide` it.
- The platform records how long each gate waited for the person who decided (`waited_seconds`). The report comes with task E06.

**Scopes.** An approval of G1, G2 or G3 has no scope. The API refuses an approval that sends one (`scope_not_allowed`).

**The project AI record (before G1).** An intent enters G1 only when the project's AI record allows the intent's data class (Chapter 2 §2.5, D-02 FR-19).

- The platform keeps the record as codes: AI use allowed (`no`, `yes`, `yes_with_conditions`), the allowed data classes, AI on production logs and data (`no`, `yes_masked`), the disclosure format (`client_format`, `standard_note`), the date the client confirmed in writing, and a link (`https://`) to the human record of template T7 (for example `docs/project/ai-record.md`). The client contact, the allowed tools and locations and any special conditions stay in that human record, never in the platform.
- Until the client has answered in writing (no confirmation date), client data is handled only as `client_restricted`: the record cannot allow `client_confidential`, and an intent with that data class waits. `prohibited` is never allowed. When AI use is `no`, no client data class is allowed. The platform never changes an intent's data class: get the written answer, or create the intent again with the right class.
- When the check fails, the intent stays a draft and the platform posts one status comment with the reason code, mentioning the people who may write the record. When the record is fixed, the intent enters G1 by itself within a few minutes.
- Who may write the record: Person A and PM / BrSE by default (project setting `access.ai_record_write_roles`; the viewer role never may). Every change is a new version; the platform keeps every version and records who made it.
- How to write it:
  - through the API: `GET` and `PUT /v1/projects/<project>/ai-record` with your personal token. `PUT` needs `expected_version` (the version you read; `0` for the first version). The CLI does the same: `sdlc ai-record show|set` (§19.8c).
  - the platform operator, on the server, for a new project: `sdlc ops ai-record set --tenant <slug> --project <slug> --on-behalf-of <email> --expected-version <n> --ai-allowed <…> --classes <a,b | none> --prod-logs <…> --disclosure <…> [--confirmed-at YYYY-MM-DD] [--record-ref https://…]` and `sdlc ops ai-record show --tenant <slug> --project <slug>`. The person named with `--on-behalf-of` must hold a write role on the project: they are accountable for the content.

---

## 19.8c. Using the platform: the `sdlc` command

> **Platform usage section, owned by Claude Code** (CLAUDE.md "Documentation rules"). Written with task B04, 2026-10-03, and kept in line with the platform code (`design/ADR-M36-cli-api-client.md`).

The `sdlc` command does through the API what the comment commands do on GitHub, and more: create and read intents, decide gates, act on escalations, keep the project AI record.

**Log in once.**

1. Get your first personal API token (`sdlc_pat_…`) from a tenant admin (it lasts at most 7 days) or, for the first person of a tenant, from the platform operator. Keep it in your password manager. After you log in, create your own token (`sdlc token create`), log in again with it, and revoke the first one.
2. Run `sdlc login --api-url https://<platform address>` and paste the token at the prompt. The prompt does not show what you type.
   - The platform checks the token first. Only a valid token is saved.
   - The address must use `https://`. `http://` works only for a platform on your own machine (`http://127.0.0.1:8090`).
   - If your company uses its own certificate authority, add it with the standard Node setting `NODE_EXTRA_CA_CERTS=<file>`. The command never runs with certificate checks turned off.
3. `sdlc whoami` shows who you are and your roles per project.

- The token is saved in `~/.config/sdlc/credentials.json` (or under `$XDG_CONFIG_HOME`), readable only by you. It is stored as plain text, so protect your account and your disk. If the file can be read by others, the command stops until you fix it (`chmod 600`) and log in again.
- **Never put the token on the command line**, in a script, in a chat or in a ticket. There is no `--token` option. To pipe a token in (for example from a password manager), use `--token-stdin`.
- `sdlc logout` revokes the token on the server, then deletes the saved login on your machine. If the server cannot be reached, it still deletes the login and says the token is still valid: revoke it later with `sdlc token revoke` from another login.
- Your own tokens: `sdlc token create --name <name> [--days <n>]` (the new token is shown once), `sdlc token list`, `sdlc token revoke --id <ID>`. Use one token per machine.
- In CI only, set `SDLC_API_URL` and `SDLC_API_TOKEN` (as CI secrets) instead of logging in. Do not use them on your own machine: environment variables can leak into process lists and logs.

**Commands.** Add `--json` to any command for machine-readable output.

| Command | Does |
|---|---|
| `sdlc intent create --project <slug> --title <text> --risk <tier> --data-class <class> [--description <text> \| --description-file <file>] [--budget <USD>] [--issue <number>]` | Creates an intent; you become its owner (Person A) |
| `sdlc intent list [--project <slug>] [--status <status>] [--limit <n>] [--cursor <c>]` | Lists the intents you can read, newest first |
| `sdlc intent show <INT-…>` | Shows an intent with its spec, plan and gate decisions |
| `sdlc gate approve <gate> <INT-…>` | Approves the gate the intent waits at |
| `sdlc gate reject <gate> <INT-…> --reason-code <code> [--reason-ref <https://…>]` | Rejects the gate |
| `sdlc gate request-changes <gate> <INT-…> --reason-code <code> [--reason-ref <https://…>]` | Requests changes |
| `sdlc escalation list\|show\|ack\|decide …` | Chapter 18 §18.8b |
| `sdlc run list <INT-…>` / `sdlc run kill <run ID\|INT-…>` | Lists the intent's agent runs / stops a run with the kill switch: Chapter 18 §18.8d |
| `sdlc spec link <INT-…> --path <path/to/spec.md> [--commit <SHA>] [--tool spec-kit\|bmad\|manual]` | Links the intent's spec (below) |
| `sdlc spec list <INT-…>` | Lists the linked spec versions: path, commit and SHA-256 |
| `sdlc plan submit <INT-…> [--commit <SHA>]` | Submits the intent's plan file (below) |
| `sdlc plan list <INT-…>` / `sdlc plan show <INT-…>` | Lists the submitted plan versions / shows the latest one with its path patterns, tools and change flags |
| `sdlc ai-record show --project <slug>` | Shows the project AI record |
| `sdlc ai-record set --project <slug> --expected-version <n> …` | Saves a new version (same options as the operator command above, without `--tenant` and `--on-behalf-of`: you are the accountable person) |
| `sdlc cost report [--project <slug> \| --intent <INT-…>] [--from <time>] [--to <time>] [--by project\|intent\|model\|status]` | Shows tokens and cost (below) |
| `sdlc metrics gates [--project <slug>] [--gate G1..G8] [--mode HITL\|HOTL\|AUDIT\|POLICY] [--risk low\|medium\|high\|critical] [--from <time>] [--to <time>]` | Shows how long gates waited for people (below) |
| `sdlc evidence build <INT-…>` | Builds a new version of the intent's Evidence Pack, or returns the latest one when nothing changed: Chapter 15 §15.10.2 |
| `sdlc evidence list <INT-…>` / `sdlc evidence show <INT-…> [--version <n>]` | Lists the pack's versions / shows one (default: the latest) |
| `sdlc evidence export <INT-…> [--version <n>] [--manifest] [--output <file>]` | Prints or saves the readable pack (`pack.md`), or the manifest with `--manifest`, after checking its SHA-256; `--output` never overwrites a file |

- Gate decisions take **codes only**: a reason code (§19.8b) and, if you want, `--reason-ref` with an `https://` link to a comment that explains it. The platform never stores your words, because its records are kept for years.
- The rules are the same as for comments (§19.8b): you need the gate's role, you can decide only the gate the intent waits at, and a producer never approves.

**Linking a spec (G2 input).** G2 checks the intent's spec. Link it with `sdlc spec link` (task B08, `design/ADR-M39-spec-linking.md`):

- Who: Person A and PM / BrSE by default (project setting `access.spec_link_roles`; the viewer role never may).
- When: while the intent is a draft or waits at G1, G2, G3 or G4.
- What: a Markdown file (`.md` or `.markdown`) in the repository, at most 256 KiB, UTF-8 text. The platform reads it from GitHub and keeps only its SHA-256, never the content.
- **The spec is the file on the default branch** (`main`): the agent run starts from there. Leave out `--commit`, or give a commit that holds the same content as the default branch; otherwise the platform refuses (`spec_not_on_default_branch`).
- **If someone edits the spec on the default branch after G2**, the platform notices it at the next step: it links the new version, takes the intent back to G2 and posts a comment (`spec_changed`). Approvals of the old spec no longer count. At Low risk G2 is HOTL, so the platform may pass the new spec again, with its block window; at other tiers a person approves it again.
- If the file is removed, renamed or cannot be read, the intent goes back to G2 and waits (`spec_unavailable`) until you restore it or link another spec.
- If GitHub cannot be reached, the intent waits; it never passes a gate without the check.

**Submitting a plan (G3 input).** G3 checks the intent's task plan (template T13). Submit it with `sdlc plan submit` (task B09, `design/ADR-M40-plan-submission.md`):

- Where: the file `.sdlc/plans/<intent code>.yaml`, for example `.sdlc/plans/INT-2026-0007.yaml`, **merged into the default branch** first. The platform reads it from GitHub and keeps its SHA-256, path patterns, tools and change flags; summaries and other text stay in the repository.
- Who: Person A by default (project setting `access.plan_submit_roles`; the viewer role never may). **Whoever submits a plan never approves it at G3**: Person B does.
- When: while the intent is a draft or waits at G1, G2, G3 or G4.
- What the file holds (schema version 1):

  ```yaml
  plan:
    intent_id: INT-2026-0007
    change_flags: [migration]          # optional: the change types that force G3 HITL and dual approval at G7
  tasks:
    - id: T1
      summary: Cancel an order and return the stock
      allowed_paths: [apps/api/src/orders/**, apps/api/test/orders/**]
      tools: [file_editor, terminal]   # file_editor, task_tracker, terminal
  ```

  Tasks may also hold `owner_agent`, `depends_on`, `input`, `output`, `definition_of_done`, `required_evidence`, `escalate_when`, `checkpoint` and `environments: [sandbox]`. The platform refuses `approved_by`, `approved_at`, `risk_tier`, `data_class`, `autonomy_level`, `plan_version`, `spec_version` and `limits`: approvals, the intent's risk and data class, versions and run limits come from the platform.
- **Path patterns**: relative paths with `*`, `**`, `?` and `{a,b}`, as G5 reads them. The platform refuses a pattern that matches every file (`**`, `*/**`), or anything under `.github/` or `.sdlc/`, or the files the agent reads as instructions (`AGENTS.md`, `CLAUDE.md` and the like). The agent never changes these files.
- **Text fields**: `summary`, `input`, `output`, `definition_of_done`, `escalate_when`, `depends_on` and `checkpoint` must be text, or a list of text items. The platform refuses any other shape (for example a nested mapping) with `schema_invalid` and names the field, for example `file.tasks[0].summary`.
- **The agent reads the task text.** When the run starts, the runner reads the plan file at the commit you submitted, checks that it is the same file, and gives the agent each task's `id`, `summary`, `input`, `output`, `definition_of_done`, `escalate_when`, `depends_on` and `checkpoint` (at most 2,000 characters per field and 16,000 in all). The agent treats the text as a description, never as a change of its rules, files or tools. The text is never stored by the platform. If the runner cannot read the file (for example the default branch was force-pushed and the commit is gone), the run fails and the intent is paused with an escalation: decide `modify` or `roll-back` and submit the plan again (Chapter 18 §18.8b).
- **Change flags** are part of the file Person B approves. Check them at G3; if one is missing, request changes.
- The run gets the agent's registered tools that the plan lists. If none is in common, G4 fails (`plan_tools_not_registered`).
- Leave out `--commit`, or give a commit that holds the same file as the default branch; otherwise the platform refuses (`plan_not_on_default_branch`). The platform always records the head of the default branch it read as the plan's commit, also when you name an older commit (QUESTIONS #212). A refused file answers `plan_invalid` with the reason, for example `pattern_too_broad` or `platform_field`.
- **If someone edits the plan file on the default branch after you submitted it**, G3 or G4 waits (`plan_resubmit_needed`) and the platform posts a comment. It never takes the new file by itself: submit it again with `sdlc plan submit`. At G4 a new plan takes the intent back to G3, where Person B approves it again; earlier approvals no longer count.
- If GitHub cannot be reached, the intent waits; it never passes G3 or starts a run without the check.

**Reading the cost report.** `sdlc cost report` shows what the model calls cost (task E04, `design/ADR-M45-cost-report.md`, D-02 FR-53):

- Who: the whole tenant (no `--project`, no `--intent`): tenant admins only. One project or one intent: a tenant admin, or a role in the project setting `access.cost_read_roles` (by default Person A, Person B, PM / BrSE, governance and admin). The viewer role never may.
- When: times are UTC, written `YYYY-MM-DD` (00:00 that day) or `YYYY-MM-DDThh:mm:ssZ`. `--from` is included and `--to` is excluded: `--from 2026-10-01 --to 2026-11-01` is all of October. Without them, the report covers the current month until now. At most 366 days. A range that is empty (`--to` not after `--from`) or longer than 366 days is refused: the API answers 400 `invalid_request` with the reason `range_empty` or `range_too_long`, and the command exits with code 2. So does a time in another format, or `--project` together with `--intent`.
- The table has one row per project (whole tenant), per intent (one project) or per model (one intent); `--by` chooses another grouping, also `status` (the run's status). Each row and the total show the calls, tokens in, tokens out, cached tokens, cost, wasted tokens and wasted cost. Amounts are USD with 6 decimals. At most 500 rows are shown, largest cost first; the total always covers everything.
- **Wasted** = tokens and cost of runs that ended failed, cancelled or stopped (budget, scope, time, stalled, killed). Runs that succeeded, and L1 runs that produced a proposal, are not wasted. Runs sent back later by G6 or G7 are not counted as wasted yet.
- **The numbers are as fresh as the last copy from the model gateway.** The platform copies a run's spend when the run ends. Every report ends with the time of the latest recorded call, the time of the last copy, and the number of runs still in progress, whose cost is not shown yet.

**Reading the gate waiting times.** `sdlc metrics gates` shows how long the gates waited for a person's decision (task E06, `design/ADR-M47-gate-metrics.md`, D-02 FR-12). Use it to see whether the gates slow the team down.

- Who: the whole tenant (no `--project`): tenant admins only. One project: a tenant admin, or a role in the project setting `access.metrics_read_roles` (by default Person A, Person B, the second approver, PM / BrSE, governance and admin). The viewer role never may.
- When: the same time formats as the cost report. `--from` is included, `--to` is excluded. Without them, the last 30 days until now. At most 366 days; a bad range is refused with 400 and exit code 2. The range selects the decisions by the time they were recorded.
- What one row shows, per project and gate:
  - **first round**: the decisions people made (approve, reject, request changes) with no request for changes before them at the same gate in the same visit. This is the time the gate waited for a person.
  - **after changes**: the decisions after a request for changes at the same gate. The time still counts from the moment the intent entered the gate, so it includes the time the producer spent on the changes.
  - For each: the number of decisions, the average, the median, the 90th percentile (P90) and the maximum.
  - **Passed by the platform**: HOTL and AUDIT passes at G1–G3, G7 and G8. They are counted, never mixed into the times.
  - **At the gate now** and **Oldest**: the intents waiting at the gate now, and the longest wait. Every gate is shown; at G4 to G6 an intent may wait for a run or for CI, not for a person. The range and `--mode` do not apply to them.
- **Wall-clock time**, not working hours: a gate entered on Friday evening and approved on Monday morning waited the whole weekend.
- Decisions the platform makes by itself (G4 policy checks, G5 and G6) never count. A block of a passed gate never counts. Each approval of a dual approval counts.
- The report never shows who decided: it is about the gates, not about people.
- `--gate`, `--mode` (the oversight mode of the decision) and `--risk` (the intent's risk tier) narrow the rows. At most 500 rows are shown.

**When a command fails.** The message says why. The exit code tells scripts what happened:

| Exit code | Meaning |
|---|---|
| 0 | Done |
| 1 | The platform refused (no role, not found, conflict, rule broken, too many requests) |
| 2 | Wrong command or options, not logged in, unsafe saved login |
| 3 | The platform could not be reached or answered something unexpected |
| 4 | Your token is missing, expired or revoked: get a new one and run `sdlc login` |

## 19.8d. Using the platform: setting up a team (admins)

> **Platform usage section, owned by Claude Code** (CLAUDE.md "Documentation rules"). Written with task B13, 2026-10-03, and kept in line with the platform code (`design/ADR-M37-admin-onboarding.md`).

Before anyone can approve a gate, an admin sets up the project and the team: the project, the people, their GitHub accounts and their roles.

**Who is an admin.**

- A **tenant admin** manages the whole tenant: projects, people, GitHub accounts, roles, project configuration, and other tenant admins. The first person of a tenant becomes tenant admin when the platform operator creates the tenant on the server.
- A person with the project role **`admin`** manages the roles and the configuration of that project only.
- Being an admin does not let you approve anything. Gate approvals still need the gate's role (§19.8b).

**The rules the platform enforces.**

- **Nobody gives a role to themselves**, and nobody disables themselves. Ask another admin. A team with only one admin asks the platform operator, who does it on the server (`sdlc ops role grant`).
- **Person A and Person B are never the same person on a project.** Some other pairs of roles are kept apart too; the project configuration lists them (`access.conflicting_roles`, by default also Person B and the second approver). A role that would break a pair is refused.
- **The tenant always keeps one tenant admin.** The last one cannot be removed or disabled: make someone else a tenant admin first.
- A role is never deleted: it is revoked, and the history stays. A GitHub account is unlinked, not deleted.
- A GitHub account is linked by its **numeric account ID**, never by its login, because a login can change. Find the ID with `gh api users/<login> --jq .id`.
- Every change is recorded in the audit log with IDs and codes only: never a name, an e-mail address or a login.

**Set up a new project, step by step** (all commands take `--json`):

1. Create the project: `sdlc admin project create --slug <slug> --name <name> --repo <owner/name> [--default-branch <branch>]`.
2. Add each person: `sdlc admin user create --email <email> --name <name>`.
3. Link each person's GitHub account: `sdlc admin identity link --user <email> --github-id <numeric ID> --github-login <login>`. Without it, the person's `/approve` comments are refused.
4. Give the roles: `sdlc admin role grant --project <slug> --user <email> --role <role>`, for example `person_a`, `person_b`, `second_approver`, `pm_brse`, `governance`, `admin` or `viewer` (Chapter 5).
5. If the project needs settings other than the defaults, upload its configuration: `sdlc admin config show --project <slug>` shows the version in force (0 = the defaults), then `sdlc admin config set --project <slug> --file <config.yaml> --expected-version <version>`.
   - The platform refuses a configuration that loosens a mandatory rule, and says which line and which rule.
   - It accepts other loosening (for example HOTL instead of HITL at G2 for Medium risk), shows a warning for each, and records the warnings in the audit log.
6. Ask the PM / BrSE or Person A to save the project AI record (`sdlc ai-record set`, §19.8b). Intents wait before G1 until it exists.

**Other admin commands.**

| Command | Does |
|---|---|
| `sdlc admin project list`, `show`, `update`, `archive` | An archived project takes no new roles or configuration |
| `sdlc admin user list`, `show`, `update`, `disable`, `enable --user <id or email>` | A disabled person's tokens stop working at once |
| `sdlc admin identity list [--all]`, `unlink --user <id or email> --id <identity ID>` | `--all` also shows unlinked accounts |
| `sdlc admin role list --project <slug> [--all]`, `revoke --project <slug> --id <role ID>` | `--all` also shows revoked roles |
| `sdlc admin tenant-admin grant --user <id or email>`, `list [--all]`, `revoke --id <ID>` | Tenant admins only |
| `sdlc admin token issue --user <id or email> --name <name> [--days <1-7>]` | A first token for a new person, shown once. It lasts at most 7 days: the person creates their own token and revokes this one |
| `sdlc admin token list\|revoke --user <id or email> …` | Anyone's tokens, for example after a laptop was lost |
| `sdlc admin agent …` | The agent register, Chapter 20 §20.5b |
| `sdlc audit verify` | Checks your tenant's audit log (exit code 1 when a record was changed) |

**Operator commands on the server.** The platform operator keeps a few commands that work straight on the database, for the first person of a tenant and for when the API is down: `sdlc ops bootstrap`, `sdlc ops token …`, `sdlc ops audit verify`, `sdlc ops tenant-admin …`, `sdlc ops role grant|revoke` (for a team with only one admin), `sdlc ops ai-record …`, and `sdlc ops agent show|list|suspend|quarantine`. They are recorded in the audit log as done by the platform.

- When the platform is upgraded and its default settings change, it checks every stored project configuration when it starts. A configuration nobody changed is saved again with the new defaults, and the audit log shows it as a change by the platform. A configuration that was changed outside the platform, or that the new defaults make invalid, is not used: the project stops until an admin saves a configuration again.

## 19.9. Roles and approval points

| What | Who |
|---|---|
| Routing rules per project | Person A proposes; Person B agrees; recorded in the project AI record |
| Backup reviewer | Named by leadership per project |
| Safe list of actions that may continue while waiting | Leadership (Chapter 6 §6.5) |

---

## 19.10. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Reviewers approve quickly to clear the queue | Decision packet; approval time and rejection rate watched; Person B's load shared |
| Stale approvals used for changed work | Binding to version, scope, environment, expiry; re-check before acting |
| Everything classified as "needs approval" | Oversight by risk tier; review the classification monthly |

---

## 19.11. References

**Related documents**
- Handbook: codes table §4; Chapters 4, 5, 6, 8, 17; templates T2, T8.

---

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.0 | 2026-09-24 | — | Skeleton |
| 0.1 | 2026-09-24 | Claude (draft) | First content |
| 0.2 | 2026-09-27 | Claude (task B07, session 2) | §19.8b platform usage: HOTL gates and the block window, gate deadlines and their escalation, no scope at G1–G3 (ADR-M30 §2.4b, §2.9) |
| 0.3 | 2026-10-03 | Claude (task B04) | §19.8c platform usage: the `sdlc` command (login, intents, gates, AI record, exit codes); §19.8b points to it (ADR-M36) |
| 0.4 | 2026-10-03 | Claude (task B13, PR 1) | §19.8d platform usage: setting up a team (tenant admins, projects, people, GitHub accounts, roles, configuration; ADR-M37) |
| 0.5 | 2026-10-03 | Claude (task B13, PR 2) | §19.8c: `sdlc logout` revokes the token; `sdlc token`; first token from a tenant admin. §19.8d: tokens of other people, the agent register, `sdlc audit verify`, the operator commands `sdlc ops` (ADR-M37 §2.8) |
| 0.6 | 2026-10-03 | Claude (task B08) | §19.8c: `sdlc spec link|list`; the spec is the file on the default branch and is checked again at G2–G4 (ADR-M39) |
| 0.7 | 2026-10-03 | Claude (task C08, PR 2) | §19.8: which gates can be decided by comment, G6 included (ADR-M38 §2.7) |
| 0.8 | 2026-10-03 | Claude (task B09, PR 1) | §19.8c: `sdlc plan submit|list|show`; the plan file, its rules, who submits, the re-check at G3–G4 (ADR-M40) |
| 0.9 | 2026-10-03 | Claude (task C11, PR 1) | §19.8b, §19.8c: `/kill` and `sdlc run list|kill` point to Chapter 18 §18.8d (ADR-M42) |
| 0.10 | 2026-10-04 | Claude (task E04) | §19.8c: `sdlc cost report`: who, the range, the grouping, wasted tokens, freshness (ADR-M45) |
| 0.11 | 2026-10-04 | Claude (task E06) | §19.8c: `sdlc metrics gates`: who, the range, first round and after changes, platform passes, intents at the gate now, wall-clock time (ADR-M47) |
| 0.12 | 2026-10-04 | Claude (task E02) | §19.8c: `sdlc evidence build\|list\|show\|export` (ADR-M48) |
| 0.13 | 2026-10-04 | Claude (task B09, PR 2) | §19.8c: plan text fields must be text (`schema_invalid` with the field); the agent reads the task text from the submitted plan file; the recorded commit is the head read (QUESTIONS #169, #210, #212) |
