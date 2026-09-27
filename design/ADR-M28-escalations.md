# ADR-M28. Escalations: routing, durable clocks in the database, freeze

| Item | Value |
|---|---|
| Status | **Proposed** (task B11; PR 1 merged, PR 2 for review) |
| Date | 2026-09-27 |
| Decided by | Harry (plan approved 2026-09-27: QUESTIONS #73–#77 as recommended, with conditions) |
| Related | D-02 FR-12, FR-17, FR-18, §10 item 5c; D-03 sections 6, 6.4 (version 1.7), 12 (ADR-M14); D-05 sections 5, 6.1b, 6.4b (version 1.9), 10; D-08 tasks B07, B10, B11, C06, C07, C08, C11, E01, E03; handbook codes table §6.3, Ch.6 §6.4–§6.6, template T16; ADR-M09, ADR-M14, ADR-M18, ADR-M20, ADR-M27; QUESTIONS #21, #73–#77 |
| Supersedes | **ADR-M14 in part**: the escalation clocks are not Temporal timers (§2.2) |

## 1. Context

Task B11 builds escalations (FR-18): a trigger, a severity, a response level, an owner and a backup owner, two clocks (acknowledge and resolve) from the SLA table, and a freeze of sensitive work when nobody answers. D-03 §6.4 and ADR-M14 put the clocks in the Temporal intent workflow, but that workflow comes later (B07). Five points were open (QUESTIONS #73–#77):

- how the clocks survive restarts before B07 exists;
- how an escalation is routed, and what happens when a role has no holder;
- the reminder point and the chain owner → backup → governance;
- which escalations freeze the intent, and which actions continue;
- where `ack` and `decide` live (API, comments, CLI) and the decision codes.

## 2. Decision

### 2.1. Routing from configuration and role bindings (QUESTIONS #74)

- Each escalation has a `route`: `intent`, `technical`, `security` or `policy` (handbook Ch.6 §6.4 "Who receives it"). Whoever raises it picks the route.
- The roles per route come from the project configuration, `escalation.routing.<route> = { owner_role, backup_role }`:

  | Route | Owner role | Backup role |
  |---|---|---|
  | `intent` | `person_a` | `person_b` |
  | `technical` | `person_b` | `second_approver` |
  | `security` | `person_b` | `second_approver` |
  | `policy` | `governance` | none |

- **Governance is always the last step** (rule M17). M17 also requires: the `policy` route is owned by governance; `viewer` never receives an escalation; the backup role differs from the owner role.
- The holder of a role is the person with the **earliest active binding** for it on the project, whose user is active. Revoked bindings and disabled users never count.
- **Producers are never chosen** (FR-18: authority never passes back to them). The owner is never also the backup. CHECK constraints repeat both rules.
- A role with no holder leaves its step empty, and the clock skips it: owner → backup → governance. `owner_id` and `backup_owner_id` are nullable.
- When nobody holds any of the three roles, the escalation is **unrouted**. It starts at the governance step, stays frozen, and writes the audit event `escalation.unrouted`. Raising never fails because of routing: frozen is the safe default.
- The backup is chosen again just before the owner step runs out, because roles can change hands while an escalation waits.

### 2.2. Clocks in the database, advanced by the worker (QUESTIONS #73, #75)

- **Option A (approved):** the clocks live in the `escalations` row: `step_due_at`, `remind_at`, `resolve_due_at`, and `next_check_at`, which holds the earliest pending one.
- A plain loop in the worker (`EscalationLoop`, `platform/apps/worker/src/escalation-loop.ts`, the same pattern as the poller of ADR-M27 D1) runs every `SDLC_WORKER_ESCALATION_TICK_MS` (default 15 s):
  - it reads the due escalations with `SystemScope.listDueEscalations(now, limit)` (IDs only, across tenants, active tenants only);
  - it advances each one with `advanceEscalation` (`@sdlc/core`) in its tenant's scope.
- `advanceEscalation` locks the row with `FOR UPDATE SKIP LOCKED` and applies the pure function `advanceClock` (`core/src/escalation/clock.ts`). Two workers never apply the same step. Running it twice at the same time changes nothing. After a restart, an escalation that ran out while the worker was down catches up, in time order.
- **Rules of the clock** (handbook Ch.6 §6.4–§6.5):
  - Two clocks always run from creation: acknowledge (per step) and resolve. Sending a message is not an acknowledgement.
  - At `escalation.reminder_percent` (default 75, [Proposal] pilot default) of the acknowledge window, the step's holder is reminded.
  - When the window runs out, the escalation moves to the next step. The next step gets a **fresh** acknowledge window from the same SLA row, starting when the previous one ran out.
  - When governance misses its window too, `escalation.ack_overdue` is recorded once, and the escalation stays frozen.
  - When the resolve deadline passes without a decision, governance takes over (`escalation.resolve_overdue`). For Critical, `escalation.incident_due` is also recorded. The incident module is MVP+1, so this is an audit event and a notice only.
  - Working-time units follow the project's working calendar, holidays included (`escalation.calendar`, ADR-M18). "Next planned work" (Low) has no resolve clock.
- **This partly supersedes ADR-M14** ("escalations as part of the Temporal intent workflow") and D-03 §6.4 ("Temporal timers inside the intent workflow"; D-03 version 1.7 has the note).
  - **B07 must not add a second timer for the same clock.**
  - B07 attaches through the same functions: it raises escalations, asks `checkFreeze` before it acts, and waits for a resolved escalation. B07 decides how the workflow learns about a decision (a signal sent from the decide path, or a read of the status); it never times the escalation itself.
- Not chosen: one Temporal workflow per escalation now. It would add `@temporalio/client`, `worker`, `workflow` and `activity` (1.24.0, MIT) and the test server, and pull B07's Temporal setup into B11.

### 2.3. Codes only: packet and decision

Escalations are kept at least 2 years (D-05 §10), so they hold codes, IDs, hashes and references only (CLAUDE.md "Current constraints").

- `packet` is the decision packet of template T16, reduced to its coded fields (`EscalationPacket`, `core/src/escalation/packet.ts`):
  - `subject_kind` and `subject_sha256`: the reviewed version the decision is bound to (FR-17);
  - optional `gate`, `run_id`, `agent_id`, `reason_code` (a gate reason code), `recommendation` (`approve`, `modify`, `reject`);
  - optional `ref`: one `https://` link to the words (the Git host comment, the CI run).
- The words of the T16 package (goal, diff, command, impact) stay where they can be edited or deleted: the issue, the pull request, the evidence files.
- `decision` holds the decision code, the bound hash, the allowed actions, the expiry and a `ref` (§2.7).
- A CHECK function refuses anything else: nested values, strings with spaces or `@`, or a `ref` that is not an https link.

### 2.4. Freeze and status moves (QUESTIONS #76, #77)

- An escalation **freezes its intent** when it is not `closed` and either:
  - its response level is `pause`, `contain` or `incident`; or
  - its acknowledgement was missed (`ack_missed_at`): `observe` and `notify` freeze from then on.
- **A G5 breach uses at least `pause`** (QUESTIONS #21): `raiseEscalation` refuses a packet with `gate: G5` below `pause`. C07 raises the G5 escalations; the run stops, and only a person's decision resumes it.
- `checkFreeze(scope, intentId, action)` and `assertActionAllowed` (`core/src/escalation/freeze.ts`) are the one place to ask before acting:

  | Task | Action |
  |---|---|
  | B07 | `gate_advance` |
  | C06 | `run_start` |
  | C07 | `run_resume`, `budget_increase` |
  | C08 | `push`, `open_pr` |
  | E01 | `merge` |
  | E03 | `release` |

- **Safe list:** config `escalation.safe_actions`, chosen from the handbook's codes only (`read_only`, `sandbox_test`, `unpublished_draft`, `collect_metrics`). A project can shorten the list, never add a risky action.
- **Containment** (`kill_run`, `revoke_credentials`, C11) is never frozen.
- An unknown action code is treated as protected.
- Human gate decisions are not frozen; the workflow cannot advance while the intent is frozen.
- **Status moves** (trigger, SQLSTATE `SDA07`):
  - `open` → `acknowledged`, `resolved` or `closed`;
  - `acknowledged` → `resolved` or `closed`;
  - `resolved` → `acknowledged` (a decision voided because it expired or no longer matches) or `closed`.
  - Nothing changes once `closed`. The acknowledgement is written once. A decision is replaced only by clearing it.
- `resolved` still freezes, except for the actions its decision allows (§2.7): the caller acts on the decision and then closes the escalation.
- Decision codes (template T16): `resume`, `modify`, `roll_back`, `terminate`, `escalate_further`.

### 2.5. Notices

- `raiseEscalation` and the clock record notices in `escalation_notices`: a kind code, the step and the audience **role** (never a person). Each notice is recorded once per kind, step and role.
- The poller posts them as comments on the intent's issue, rendered from the message catalog, with the same delivery rules as B06 replies (§2.7). A posted or abandoned notice is final (`SDA08`).
- **On raise:** the role of the first step, plus `escalation.notify_on_raise[severity]` (handbook Ch.6 §6.4, SLA table "Notify"):

  | Severity | Roles told |
  |---|---|
  | Critical | governance, Person A, Person B |
  | High | governance, Person A, Person B |
  | Medium | Person A, Person B |
  | Low | Person A |

  - A **Critical escalation tells governance at once** (codes table §6.3 "15 minutes, to leadership"; Harry's condition on #74), so leadership never waits for the step chain.
  - M17 requires each list to contain at least the handbook's roles.
- **Clock events:**

  | Event | Roles told |
  |---|---|
  | Reminder | The step's role |
  | Step change | The new step's role and the missed step's role |
  | Governance overdue | Governance |
  | Resolve overdue | Governance and the step's role; for Critical, also the incident notice to governance |

- A second channel (e-mail, chat) is MVP+1.
- **Notifying the client** (Critical "client per contract", handbook Ch.6 §6.4 SLA table) is **not in the MVP**: the platform tells project roles only. Leadership or PM/BrSE tells the client outside the platform (Ch.6 §6.7 step 3b).

### 2.6. Where the rules live

| Rule | Source | Enforced |
|---|---|---|
| SLA acknowledge and resolve times | Config `escalation.sla` (codes table §6.3, Ch.6 §6.4) | M11 (never longer than the handbook) |
| Working calendar | Config `escalation.calendar` | M11 floor |
| Owner and backup role per route | Config `escalation.routing` | M17 |
| Governance is the last step | Handbook Ch.6 §6.5 | Code (`GOVERNANCE_ROLE`) and M17 |
| Who is told on raise | Config `escalation.notify_on_raise` | M17 (contains the handbook's roles) |
| Reminder point | Config `escalation.reminder_percent` | 1–99 |
| Safe list | Config `escalation.safe_actions` | Enum of the handbook's safe codes |
| Decision expiry and binding | Config `oversight.approval_expiry`; FR-17 | Code |
| Producers never own, back up, acknowledge or decide | FR-18 | Code and CHECK |
| No answer never means "go ahead"; containment never frozen | Ch.6 §6.5 | Code |
| A G5 breach needs at least `pause` | QUESTIONS #21 | Code |
| Tick and batch size of the loop | Worker settings `SDLC_WORKER_ESCALATION_*` (technical) | Settings schema |

- The default `config_hash` changes (new `escalation` keys), as in ADR-M25 and ADR-M26.

### 2.7. Acknowledge and decide: comments, API, binding (PR 2)

- **Comments** (same parser, handler and receipts as B06, ADR-M27):
  - `/ack [ESC-…]` acknowledges. Nothing may follow the code.
  - `/decide [ESC-…] <resume|modify|roll-back|terminate|escalate> [reason_code] [reason]` decides.
  - The code may be left out when the intent has exactly one escalation that is `open` or `acknowledged`; with more than one, the reply is `escalation_ambiguous`.
  - A named code must belong to the intent of the issue.
  - Numeric GitHub account IDs only; bots are ignored without a reply.
  - The receipt records `acknowledged` or `escalation_decided` with `escalation_id`.
  - Refusals get a catalog reply (`comment.reply.escalation_*`, `syntax_decision_*`); a successful command gets none.
  - The comment URL is the decision's `ref`; the reason text stays on GitHub.
- **API** (`@sdlc/api`, ADR-M26):
  - `GET /v1/escalations[?intent=&status=&limit=]`, `GET /v1/escalations/:code`.
  - `POST /v1/escalations/:code/ack` (200) and `POST /v1/escalations/:code/decisions` (201). The decisions body is `{ decision, reason_code?, reason_ref?, actions?, budget_increase_usd? }`.
  - Reading follows the intent access rules (no read role → 404).
  - Errors `escalation_not_found` (404), `forbidden` (403), `escalation_not_open` and `escalation_already_acknowledged` (409), `escalation_decision_not_allowed` (422).
  - The CLI commands come with B04 (backlog v1.6).
- **Who may act** (`actingRoles`): the owner role of the route; the backup role once the escalation reached the backup step; governance at any time. Never a producer, never an inactive user. A CHECK repeats the producer rule.
- **Decision record** (flat, coded):
  - `decision`, `subject_sha256` (from the packet), `expires_at` (`oversight.approval_expiry` in the working calendar);
  - optional `reason_code` and `ref`;
  - one `allow_<action>: true` per protected action it allows;
  - `budget_increase_usd` (a decimal string) when it allows `budget_increase`.
- **Default scope** when the decider names no actions (`DEFAULT_DECISION_ACTIONS`, a platform mechanism, not a handbook rule):

  | Decision | Protected actions allowed |
  |---|---|
  | `resume` | `run_resume`, `run_start`, `gate_advance` |
  | `modify` | `gate_advance` |
  | `roll_back`, `terminate` | none (cancelling and rolling back are never frozen) |

- **A budget increase is never a default** (Harry, PR #98). A decision allows `budget_increase` only when it names it explicitly with an amount (`budget_increase_usd`, above zero; API now, CLI in B04). The amount is bound in the decision and written to the `escalation.decided` audit event; the caller (C07) raises the budget by this amount at most. An amount without the action, or the action without an amount, is refused. Comments never name actions, so **a comment never raises a budget**.
- `decideEscalation` also records the acknowledgement when there was none.
- `escalate_further` records no decision: it moves the escalation to governance. An open escalation gets a fresh acknowledge window; the step-changed notice is recorded.
- **Freeze with a decision:** `checkFreeze` lets an action through when a resolved escalation's decision allows it and has not expired.
- **Binding:** just before acting, the caller calls `revalidateEscalationDecision(scope, { escalationId, subjectSha256, action })`:
  - An expired decision, or one bound to another version, is voided: resolved → acknowledged, the decision is cleared, the resolve clock starts again, and `escalation.decision_voided` is recorded.
  - An action outside the scope is refused (`scope_mismatch`) without voiding.
- `closeEscalation` ends it (idempotent, `escalation.closed`).
- **Notices:** the poller posts the pending notices after its replies, as one comment per escalation, kind and step.
  - The comment is posted on the intent's issue and mentions the GitHub logins of the current holders of the notice roles, never producers. Logins are read at posting time and never stored.
  - The delivery rules are those of the replies: at least once, retries, give-up after `SDLC_WORKER_MAX_REPLY_ATTEMPTS`.
  - A notice of an intent without an issue is given up at once and logged (`notice.no_issue`).

## 3. Risks

- **A late worker delays a step.** The worker checks every 15 s by default. If it is down, an escalation catches up in order when it starts again, and the late steps are notified late. The worker's health check covers its heartbeat.
- **Duplicate notices after a crash**: the same accepted risk as B06 replies.
- **Notices wait for the poll.** They are posted by the poller of the project (every `github.poll_interval_seconds`, 30 s by default), so a notice can be up to one interval late.
- **A second timer in B07** would double the notices and step changes. This ADR and D-03 §6.4 forbid it.

## 4. Consequences

- D-05 version 1.9: new enums `escalation_route` and `escalation_step`; §6.4b `escalations` as built (clock columns, `producer_ids`, nullable owners, decision columns); new table `escalation_notices`; `git_event_receipts.escalation_id`.
- D-03 version 1.7: §6.4 and §12 (ADR-M14) note.
- `@sdlc/config`: new keys under `escalation`, rule M17; the default `config_hash` changes.
- Worker: settings `SDLC_WORKER_ESCALATION_TICK_MS` (default 15000) and `SDLC_WORKER_ESCALATION_BATCH` (default 100).

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-09-27 | Claude (task B11, PR 1) | First version |
| 0.2 | 2026-09-27 | Claude (task B11, PR 1 review) | §2.5: notifying the client stays out of the MVP (Harry) |
| 0.4 | 2026-09-27 | Claude (task B11, PR 2 review) | §2.7: `resume` no longer allows `budget_increase` by default; a budget increase needs an explicit amount, bound and audited (Harry) |
| 0.3 | 2026-09-27 | Claude (task B11, PR 2) | §2.7 as built: comments, API, acting roles, decision record and default scope, binding and void, close, notices; §2.2 how B07 learns about a decision; §3 notice delay |
