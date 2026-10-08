# M-E trial plan: tasks T01–T10 on the sample repo

| Item | Value |
|---|---|
| Version | 1.6 |
| Date | 2026-10-08 |
| Status | **Approved** (Harry, 2026-10-06): decisions D1–D5 as proposed; D6 (the local model, QUESTIONS #81) |
| Readers | Harry, the trial team (Person A, Person B, second approver), Claude Code |
| Related documents | D-02 §2, §10, §13.3 (milestones M-E, M-F); D-09 §7 (tasks T01–T10, scenarios N1–N10); `design/MVP-DONE.md`; `platform/GETTING-STARTED.md` Steps 11–14 |

---

## 1. Purpose

- Run the ten sample tasks T01–T10 of D-09 through the platform, G1 to G8, on the sample repo `harryforge/pilot-order-inventory`.
- Collect real numbers (D-02 §2 "Expected results"): gate waiting time, tokens and cost, the share of pull requests that needed changes.
- Find what is too heavy or missing before M-F adjusts gates, budgets and rules.
- M-E is done when the data report (section 8) exists (D-02 §13.3).

## 2. Scope

| In | Out |
|---|---|
| T01–T10 on the sample repo, with the local model `gpt-oss:20b` (decision D6) | Real client code or data (M-F, step C) |
| | The API model: one run before M-F (QUESTIONS #81) |
| The trial team working through comments, reviews and the CLI | A web UI (MVP+1, written from this trial's data) |
| Numbers from the platform (`sdlc metrics gates`, `sdlc cost report`, evidence packs, audit) and a short manual log | Changing gates, budgets or rules during the trial (M-F) |
| Scenarios N1–N10 when they happen naturally | Forcing every unhappy scenario again (they are proven by tests: `design/MVP-DONE.md` §2) |

## 3. Before the trial starts (checklist)

| # | Item | Who | How to check |
|---|---|---|---|
| 1 | The local model (decision D6): `ollama pull gpt-oss:20b` on the owner's machine, its entry in OpenBao (`kv/litellm/providers/ollama`, runbook T11 §5d), and one real run passed | Owner | LiteLLM lists `gpt-oss-20b`; `pnpm test:agent-real` passes |
| 2 | The live G1 → G8 run on the real pilot has passed once | Owner + Person B | `SDLC_PILOT_LIVE_G8=1 pnpm test:pilot-live` |
| 3 | The platform runs on the chosen environment (decision D1) with every credentials command | Owner | GETTING-STARTED Step 13; `curl …/health/ready`; `sdlc whoami` |
| 4 | Tenant, project `pilot`, the team's users, linked GitHub identities (numeric IDs) and roles | Owner (tenant admin) | `sdlc admin role list --project pilot` |
| 5 | The pilot's AI record (data class `internal`; the repo is fictional) | Person A or PM/BrSE | `sdlc ai-record show --project pilot` |
| 6 | The agent registered and active, `model_ref` = `gpt-oss-20b` (decision D6), instructions = the pilot's `AGENTS.md` | Owner + Person B (approvals) | `sdlc admin agent show <key>` |
| 7 | The project configuration (section 6) uploaded | Owner | `sdlc admin config show --project pilot` |
| 8 | The sandbox image built and pinned (`sandbox.image`) | Owner | GETTING-STARTED Step 14 item 4 |
| 9 | The trial budget set: USD 30 in total (decision D3) | Owner | `budget.*` in the configuration; the tenant's monthly budget |
| 10 | The manual log ready (section 7.2) | Person A | A shared sheet with the columns of section 7.2 |
| 11 | Every member of the trial team has read `platform/USER-GUIDE.md` and logged in (`sdlc whoami`) | Each member | `sdlc whoami` shows the roles |
| 12 | ~~The spec and knowledge tasks are merged (QUESTIONS #285): S01, S02, K01, and K02 unless the K01 ADR deferred it~~ **Done 2026-10-08:** S01 (#209), S02 (#210), K01 (#211); K02 deferred (QUESTIONS #300) | Coordinator | D-08 milestone Pre-M-E; the trial uses `sdlc plan draft` and, after K02, the agent's document search |

## 4. People and roles

- Separation of duties is the point of the trial: Person A and Person B must be **two different people** with two GitHub accounts (rule M21). One person with two accounts would make the waiting times and the review numbers meaningless.
- Proposed holders (decision D2):

| Role | Does in the trial | Holder |
|---|---|---|
| Person A (`person_a`) | Creates intents, links specs, writes and submits plans, approves G1 and G2 (Low, Medium) | To decide |
| Person B (`person_b`) | Approves G3, G6 (High+), G7 by PR review, merges, approves G8 | To decide |
| Second approver (`second_approver`) | Second approval at G7 for flagged changes, G8 at Critical | To decide (needed only if a plan carries a G7 dual-approval flag) |
| PM / BrSE (`pm_brse`) | The AI record; checks the disclosure note at G8 | Can be Person A |
| Governance (`governance`) | Last step of unanswered escalations | Harry |

## 5. Order of work

Run the tasks one at a time at first, so a problem in one task does not hide in another. Move to the next phase only when the previous one ended without an open platform bug.

| Phase | Tasks | Risk | Expected path | Why this order |
|---|---|---|---|---|
| 1 | T01 product list Japanese labels | Low | G1 → G8; G2, G3 HOTL | The simplest full flow; checks the set-up |
| 2 | T02 SKU format validation, T03 order status filter | Low | G1 → G8 | Generated tests (G6); frontend and backend in one change |
| 3 | T04 CSV export (Shift_JIS), T05 low-stock warning, T06 consumption tax, T07 order cancellation, T08 pagination | Medium | G1 → G8; G2, G3 HITL | Business logic; T06 tests whether G2 catches an unclear spec; T07 a transaction |
| 4 | T09 multiple warehouses | High | Stops at G4 with an L1 proposal | Proposal only (no push, no PR); Person A decides what to do with it |
| 5 | T10 delete orders older than 5 years | Critical | Blocked at G4 | The agent never runs |

For every task:

1. Person A creates the intent on its GitHub issue: `sdlc intent create` with the risk tier of D-09 §7 and data class `internal`.
2. Person A links the spec: `sdlc spec link <INT> --path docs/specs/<Txx>-….md`.
3. Person A writes the plan file `.sdlc/plans/<INT>.yaml` (template T13, schema v1), opens a pull request for it, Person B reviews and merges it, then Person A submits it: `sdlc plan submit <INT>` (QUESTIONS #230; the time this takes is measured).
4. The gates run. People act through comments (`/approve G1`…), PR reviews (G7) and the merge; the agent's PR is merged by Person B only after the platform says `g7_merge_ready`.
5. After `done`: export the task's evidence pack (`sdlc evidence export <INT> --output …`) and fill the manual log.

## 6. Project configuration for the trial

Use the defaults unless a line below says otherwise. The values are the defaults on `main` today.

| Setting | Value | Note |
|---|---|---|
| `oversight.hotl_block_window` | **1 working hour** (default 4) | Decision D7. Not the 1 minute of the test suites. With the default, a Low-risk task waits up to three block windows (after G2 and G3, after G5, after G6), about 12 working hours |
| `oversight.hitl_gate_deadline` | 1 working day (default) | Overdue gates raise escalations: part of the data |
| `oversight.approval_expiry` | 7 days (default) | |
| `run.g6_ci_retries` | 2 (default) | |
| `verification.required_checks` | `[ci-ok]` | The pilot's aggregate check |
| `budget.default_intent_usd` / `default_run_usd` | 10 / 2 (defaults), or the values of decision D3 | |
| `budget.warn_percent` | 80 (default) | |
| `run.agent_key` | The trial agent's key | |
| `sandbox.image` | The pinned node24 image | |

## 7. What we measure

### 7.1. From the platform (no extra work)

| Measure | Source | Command |
|---|---|---|
| Waiting time per gate, first round and after changes | `gate_decisions.waited_seconds` (E06) | `sdlc metrics gates --project pilot --json` |
| Tokens, cost, wasted cost per task | `cost_records` (E04, C12) | `sdlc cost report --project pilot --by intent --json` |
| Lead time from intent to `done`, runs per intent, G7 requests for changes, cost | audit `intent.closed` (E03) | `sdlc evidence show <INT> --json` and the audit log |
| Share of PRs that needed changes | G7 `request_changes` per intent | From the evidence packs |
| CI failures and retries | run event `ci_checked`, notices `ci_retry` | From the evidence packs |
| Escalations by trigger and route | `escalations` | `sdlc escalation list --json` |
| Blocks within a HOTL block window (D7) | `gate_decisions`: a `reject` or `request_changes` on a gate the platform passed | From the evidence packs; count per gate |
| The audit chain intact | `audit_log` | `sdlc audit verify` at the end |

### 7.2. Manual log (one row per task)

| Column | Meaning |
|---|---|
| Task, intent code | |
| Minutes of human work per step | Spec reading, plan writing, the plan PR, each review, each decision |
| Agent result quality | Did the merged change meet the spec's acceptance criteria? (Person B: yes / partly / no) |
| Problems | Platform bugs, unclear messages, steps that felt too heavy, with the issue or PR link |
| Notes for M-F | Gates, budgets or rules that should change, and why |
| Interface | For each step done by comment or CLI: the function of `design/MVP1-UI-SCOPE.md` §3 you would have used (its code, for example B1), or one that is missing, and why (time lost, a mistake, information not found) |

## 8. The data report (the M-E deliverable)

`design/M-E-REPORT.md`, written by Claude from section 7 and reviewed by Harry:

1. Summary: did the 8-gate flow work, and was it too heavy? Say that the agent used the local model (D6): its quality and cost are not those of an API model.
2. Per task: path, lead time, runs, cost, wasted cost, requests for changes, quality.
3. Per gate: waiting time (first round, after changes), auto-passed share, overdue escalations.
4. Totals: tokens, cost, the share of PRs that needed changes.
5. Problems found, with their fix status.
6. Proposals for M-F (gates, budgets, rules, the plan-file step #230), and the input for the MVP+1 user interface scope: the interface column counted per function of `design/MVP1-UI-SCOPE.md` §3, which then becomes version 1.0 for Harry's approval.

## 9. Stop rules

| Event | Action |
|---|---|
| A platform bug blocks a task | Stop that task, report it, open a fix task (one session), resume after the fix is merged |
| A `security` escalation (instruction files, merged before approval, a failed evidence check) | Stop the trial until Harry has looked at it |
| Spend reaches the trial budget (D3) | Stop; Harry decides whether to raise it |
| Anything that looks like real client data | Never: the pilot is fictional; stop and remove it |
| The audit chain breaks (`sdlc audit verify`) | Stop the trial |

## 10. Decisions (approved by Harry, 2026-10-06; D7 2026-10-07)

| # | Question | Decision |
|---|---|---|
| D1 | Where does the trial run? | The owner's development machine, with the dev stack. The pilot is fictional, so A10 (TLS, backup on the internal server) is not needed for M-E. The internal server comes with M-F, before real client code |
| D2 | Who are Person A, Person B, the second approver? | Two different people at least; Harry as governance. Names recorded in the manual log before phase 1 |
| D3 | The trial budget | A total cap of USD 30 for T01–T10, plus the defaults per intent (10) and per run (2) |
| D4 | Unhappy scenarios | Record N1–N10 when they happen; do not force them (tests already prove them) |
| D5 | Time frame | Harry decides; phases 1–2 first, a short review, then phases 3–5 |
| D6 | Which model? (QUESTIONS #81, 2026-10-06) | The local Ollama model `gpt-oss:20b` on the owner's machine: there is no API key yet, and the pilot is fictional. The report marks quality and cost numbers as the local model's (internal cost per token, D-07 §3; not API prices). One run with an API model passes before M-F. On a 24 GB machine, run without the profile `observability` (the model needs about 14 GB). **Memory (K01, ADR-M59 §3.5, 2026-10-08):** with `gpt-oss:20b` (12 GB), `bge-m3` and an 8 GB Docker VM the host swapped (1 % free; Japanese answers 70–168 s). Before phase 1, run one task with the dev stack up and record the time; if it swaps, give Docker less memory, leave `observability` off, or decide again |
| D7 | How long is the HOTL block window? (2026-10-07) | 1 working hour instead of the default 4, to measure the flow without most of its waiting. The report counts the blocks within a window per gate (§7.1): none at all supports a shorter or per-gate window after M-E (`design/POSITIONING.md` §6) |

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-10-06 | Claude (coordinator) | Draft for Harry's approval |
| 1.0 | 2026-10-06 | Claude (coordinator), approved by Harry | D1–D5 approved as proposed; the trial budget cap is USD 30 |
| 1.1 | 2026-10-06 | Claude (coordinator), approved by Harry | §3 item 11: the trial team reads `platform/USER-GUIDE.md` and logs in |
| 1.2 | 2026-10-06 | Claude (coordinator), approved by Harry | D6: the trial runs with the local model `gpt-oss:20b`; §2 scope, §3 items 1 and 6, §8 (QUESTIONS #81) |
| 1.3 | 2026-10-07 | Claude (coordinator), approved by Harry | §7.2 an interface column; §8 item 6 counts it against `design/MVP1-UI-SCOPE.md` |
| 1.4 | 2026-10-07 | Claude (coordinator), approved by Harry | D7: the HOTL block window is 1 working hour for the trial; §6, §7.1 counts the blocks within a window |
| 1.5 | 2026-10-08 | Claude (coordinator), approved by Harry | §3 item 12: the trial waits for S01, S02, K01 and K02 (or its deferral) (QUESTIONS #285) |
| 1.6 | 2026-10-08 | Claude (coordinator), approved by Harry | §3 item 12 done (K02 deferred, QUESTIONS #300); D6: the memory finding of K01 and a timed task before phase 1 |
