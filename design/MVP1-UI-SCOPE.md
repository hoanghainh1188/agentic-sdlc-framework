# MVP+1 user interface scope (draft)

| Item | Value |
|---|---|
| Version | 0.1 |
| Date | 2026-10-07 |
| Status | **Draft** (coordinator). Candidate list only: it is checked against the trial data and approved by Harry after M-E (D-08 E07 note). No backlog task comes from this version |
| Readers | Harry, the trial team, Claude Code |
| Related documents | D-02 §3 (users), §4.2; QUESTIONS #255; ADR-M54 (the read-only dashboard, U01, U02); `design/M-E-TRIAL-PLAN.md` §7.2, §8; handbook codes table (`handbook/00-introduction/05-codes.md`) |

---

## 1. Purpose

- List the functions a web interface could offer after the read-only dashboard, by role, so the trial team can say which they really missed.
- Fix what the interface must **never** do, whatever the trial says.
- Give a proposed order. The final scope and the tasks come after M-E, from the trial's manual log (M-E plan §7.2) and its report (§8).

## 2. What exists (U01, U02)

The read-only dashboard at `http://127.0.0.1:8090/dashboard/` (ADR-M54), signed in with a personal API token held in memory:

- intents by gate: waiting time, who decides (`waiting_for`), what holds the intent (`waiting_reason`), past-deadline and frozen marks, issue and pull request links;
- one intent: decisions, runs, escalations, evidence packs;
- open escalations with their clocks; cost and gate waiting times; the audit check (tenant admins).

Every decision is made in GitHub comments and reviews, or with the CLI.

## 3. Candidate functions by role

Codes: **R** read only, **A** an action (writes through the existing API rules). "Today" says how it is done without the interface.

### 3.1. Person A (owner)

| # | Function | Kind | Today |
|---|---|---|---|
| A1 | "My work": the intents that wait for me, with the next step | R | Issue comments, `sdlc intent list` |
| A2 | Create an intent with a form (title, risk, data class, budget, issue); the project AI record checked on the form | A | `sdlc intent create` |
| A3 | Link the spec and submit the plan: pick a file on the default branch, see its hash and `allowed_paths` before submitting | A | `sdlc spec link`, `sdlc plan submit` |
| A4 | Follow a run live: status, iterations, spend against its cap | R | `sdlc run list`, the issue's notices |
| A5 | Kill a run | A | `/kill`, `sdlc run kill` |
| A6 | Approve G1, G2 (and G4 at High risk) | A | `/approve G1`, `sdlc gate approve` |

### 3.2. Person B (independent reviewer)

| # | Function | Kind | Today |
|---|---|---|---|
| B1 | "Waiting for my decision": G2, G3, G6, G8 waiting for my role, nearest deadline first | R | Issue comments, the dashboard board |
| B2 | Decide a gate: see exactly what the decision is bound to (spec and plan hashes, run proposal, evidence pack), then approve, reject with a reason code, or request changes | A | `/approve G3`, `sdlc gate …` |
| B3 | G7: a link to the pull request review on GitHub (never an approval button: G7 approvals are GitHub reviews) | R | GitHub |
| B4 | Acknowledge and decide an escalation (resume, modify, roll back, terminate, escalate), with its decision packet | A | `/ack`, `/decide`, `sdlc escalation …` |

### 3.3. Tenant admin

| # | Function | Kind | Today |
|---|---|---|---|
| T1 | Projects, users, GitHub identities (numeric ID), roles, with the Person A ≠ Person B check | A | `sdlc admin …` |
| T2 | Project configuration: a YAML editor that validates before saving, and the difference to the stored version | A | `sdlc admin config set` |
| T3 | The agent register and its approvals | A | `sdlc admin agent …` |
| T4 | API tokens (create, list, revoke, expiry) | A | `sdlc token …`, `sdlc admin token …` |
| T5 | Evidence holds, project archive | A | `sdlc admin evidence hold`, `sdlc admin project archive` |

### 3.4. Leadership and governance

| # | Function | Kind | Today |
|---|---|---|---|
| L1 | Overview: intents by status, lead time, the share of pull requests that needed changes, monthly cost against the tenant budget, overdue escalations (the M-E measures) | R | `sdlc metrics gates`, `sdlc cost report`, evidence packs |
| L2 | A client report: an intent's evidence pack as readable Markdown or PDF, with the AI disclosure note | R | `sdlc evidence export` |

### 3.5. Everyone

| # | Function | Kind |
|---|---|---|
| E1 | Refresh by itself (light polling first; server-sent events later) and browser notifications | R |
| E2 | Search by intent code, issue or pull request | R |
| E3 | Vietnamese and Japanese besides English (the catalog is ready, NFR-08) | R |

## 4. Never in the interface

These follow the platform's rules, not the trial:

- **Merging a pull request.** People merge on GitHub; the platform never merges (D-02 §5, ADR-M41).
- **Approving G7.** G7 approvals are GitHub reviews of the pushed commit (ADR-M41).
- **Changing or deleting** audit records, gate decisions, cost records or any append-only row.
- **Entering secrets**: provider keys, OpenBao key shares or tokens. These stay in the Terminal and runbook T11.
- **Raising autonomy** or giving oneself a role (separation of duties, rule M21).
- **Overriding a refusal**: the interface shows why the platform refuses (producer, wrong role, frozen), never a way around it.

## 5. Conditions before any action (A) function

An action changes state, so it needs more than the read-only dashboard has (ADR-M54):

- CSRF protection, or a design that keeps the token out of cookies (as today) and proves it;
- the same handlers as the API and the comments (`decideGate`, the escalation commands), never a second path;
- a confirmation step that shows what the decision is bound to (the input hash);
- tests that the producer and wrong roles are refused through the interface (N5);
- sign-in for more people: GitHub OAuth or company single sign-on, and access from other machines with TLS behind a reverse proxy (today: 127.0.0.1 only).

## 6. Proposed order

| Step | Content | Why |
|---|---|---|
| 1 | A1, B1 ("my work", "waiting for my decision"), E1 (refresh), A5 (kill) | Shorter gate waits are the main M-E measure; kill is containment, allowed to the producer too |
| 2 | B2, B4 (decide gates, escalations), A6 | Needs section 5 |
| 3 | A2, A3 (create intents, link specs, submit plans) | Saves remembering CLI commands |
| 4 | T1–T5 (admin) | Few users, rare use |
| 5 | L1, L2 (overview, client report), E2, E3 | Needs real data first |

## 7. What the trial should record

The trial team adds an **interface** column to the manual log (M-E plan §7.2): for each step they did by comment or CLI, which function of section 3 they would have used, or one that is missing here, and why (time lost, a mistake made, information not found). The M-E report (§8, item 6) counts these; version 1.0 of this document keeps what the trial asked for, in the order of section 6 unless the data says otherwise.

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-10-07 | Claude (coordinator) | Draft for the trial: candidate functions by role, what never goes in the interface, conditions for actions, proposed order |
