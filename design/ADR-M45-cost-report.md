# ADR-M45. The cost report

| Item | Value |
|---|---|
| Status | **Proposed** (task E04, for review) |
| Date | 2026-10-04 |
| Decided by | Harry (plan approved 2026-10-04, with answers to QUESTIONS #195–#197) |
| Related | D-08 task E04 (AC1, AC2); D-02 §3, FR-51, FR-53; D-05 D6, §6.4, §6.5; D-07 §5; ADR-M24 §2.3, §2.5; ADR-M26 §2.5; ADR-M36; ADR-M37 §2.1, §2.5; QUESTIONS #195–#197 |

## 1. Context

D-02 FR-53 asks for "a simple report per tenant / intent": `sdlc cost report` prints a table of tokens and cost. D-08 E04 adds the scopes (tenant, project, intent, time range, AC1) and the amounts: tokens in and out, cached tokens, cost and **wasted tokens** (AC2). D-07 §5 defines wasted tokens as "tokens spent on failed, cancelled or redone runs".

What existed before E04:

- `cost_records` (append-only, one row per model call, money as `numeric(18,6)`) is filled by `syncSpend` (ADR-M24 §2.5). Every row has a run: the sync skips calls without a run label (`unlabelled`), although the schema allows `run_id` to be null.
- Runs carry their final status (D-05 §6.4).
- The user CLI goes through the API (ADR-M36); tenant admins exist from `ops bootstrap` (ADR-M37 §2.1).
- **The scheduled sync of ADR-M24 §2.5 was never built** (QUESTIONS #197). `syncSpend` runs once, when a run ends (`endRunKey`, also after a kill).

## 2. Decision

### 2.1. Endpoint and command (AC1)

- `GET /v1/cost/report?project=<slug>|intent=<INT-…>&from=&to=&by=` and `sdlc cost report [--project <slug> | --intent <INT-…>] [--from] [--to] [--by] [--json]`.
- Scope: neither `project` nor `intent` → the whole tenant; `project` → one project; `intent` → one intent. Both → 400 `invalid_request` (`query.intent`, `project_and_intent`).
- No operator command (`sdlc ops cost report`): every tenant has a tenant admin from `ops bootstrap` (QUESTIONS #196).

### 2.2. Who may read it (QUESTIONS #196)

- The whole tenant: **tenant admins only** (403 `forbidden` for anyone else).
- One project or one intent: a tenant admin, or a person with a role in new project config **`access.cost_read_roles`**, default `[person_a, person_b, pm_brse, governance, admin]`.
- **Mandatory rule M28:** `viewer` is never in `access.cost_read_roles`. Cost is commercial data (client billing later, D-07 §5). M27 is reserved for C11 PR 2.
- No role on the project → 404 (`project_not_found` or `intent_not_found`), as for any object of a project the caller cannot see (ADR-M26 §2.5). Another role → 403 `forbidden`.

### 2.3. Wasted tokens (AC2, QUESTIONS #195)

- **Wasted** = the tokens (input + output) and the cost of the records whose run ended `failed`, `cancelled` or `stopped_*` (`stopped_budget`, `stopped_scope`, `stopped_timeout`, `stopped_stalled`, `stopped_killed`).
- **Not wasted:** `succeeded` and `succeeded_proposal_only` (an L1 proposal is the output G4 asked for).
- **In progress** (`queued`, `provisioning`, `running`, `stopping`): not wasted yet. The report counts these runs separately (§2.5).
- A record with no run is in the totals and never wasted.
- **Known gap: redone runs.** D-07 §5 also counts the tokens of redone runs: a run that succeeded and was then sent back (G6 CI failure, a G7 request for changes or rejection, a G5 HOTL block). The MVP does not count them, because telling them apart needs gate history: which run's result a later gate decision sent back. A later task can add it from `gate_decisions` and the run events (`ci_checked`, `g7_checked`), for example for the M-E data report.
- The two status lists are code (`WASTED_RUN_STATUSES`, `IN_PROGRESS_RUN_STATUSES` in `@sdlc/core` `cost/report.ts`); a test checks that every run status is in exactly one of wasted, in progress or success.

### 2.4. Range, grouping and numbers

- **Range:** UTC, half-open `[from, to)` on `occurred_at`. Each bound is `YYYY-MM-DD` (00:00 UTC that day) or an RFC 3339 time ending in `Z`; offsets and local times are refused. Default: from the start of the current UTC month (the tenant budget period, ADR-M24 §2.3) to now; with only `to`, from the start of the month of the last instant before `to`. At most 366 days; empty or longer → 400 `invalid_request` (`query.to`, `range_empty` / `range_too_long`).
- **Grouping** (`by`): `project` (slug), `intent` (code), `model` (gateway name) or `status` (the run's status). Default: one level below the scope: `project` for the tenant, `intent` for a project, `model` for an intent. Rows are sorted by cost (largest first), then key; at most **500** rows, with `truncated: true` when there are more. The totals always cover every record.
- **Numbers:** sums run in SQL (`numeric` for money, bigint sums for tokens). Money is a decimal string with exactly 6 decimals (`"0.300000"`); token sums are strings of digits (they can pass 2^53); the number of calls is an integer; never a JSON number for money and never a float (D-05 D6). The CLI prints what the API sends.
- **Tenant:** every query goes through `TenantScope`; the LEFT JOINs to `runs` and `intents` (and the JOIN to `projects`) each carry `tenant_id = <tenant>` (D-05 D2, the tenant guard).
- Output: `report.scope`, `from`, `to`, `group_by`, `totals`, `rows[]` (`key` plus the amounts), `truncated`, `freshness`. Human output: a table from the message catalog (`cli.cost.*`); `--json` prints the validated body.

### 2.5. Freshness (QUESTIONS #197)

The report reads `cost_records` as synced. It shows:

- `latest_call_at`: the latest model call recorded in the scope (any time);
- `last_recorded_at`: when the latest record of the scope was written by a sync;
- `runs_in_progress`: runs of the scope still in progress, whose spend is synced when they end.

The CLI prints a notice on every report: spend is copied from the gateway when each run ends. The scheduled sync of ADR-M24 §2.5 (a look-back window, because LiteLLM writes spend logs in batches) is a separate worker task (Harry adds it to the backlog); E04 does not change the worker.

### 2.6. Where the code lives

| Part | Where |
|---|---|
| Config key and rule M28 | `@sdlc/config` (`schema.ts`, defaults, `mandatory-rules.ts`); type in `@sdlc/contracts` |
| Query | `CostRecordRepository.reportTotals`, `reportRows`, `freshness`, `countRuns` (`@sdlc/core`) |
| Rules (access, range, wasted, formatting) | `@sdlc/core` `cost/report.ts` (`buildCostReport`) |
| API | `apps/api/src/cost/` |
| CLI | `apps/cli/src/commands/cost.ts`, schema in `api/schemas.ts` |

No migration: the indexes of migration 0005 cover the query.

## 3. Consequences

- The new default `access.cost_read_roles` changes the hash of every stored project configuration. At start, the api and the worker re-hash a configuration whose YAML is unchanged (B13 AC8, `checkStoredConfigsAtStart`, ADR-M37 §2.5); a test covers a configuration stored before E04.
- Until the scheduled sync exists, the report can show less than was spent: runs in progress show nothing, and calls LiteLLM writes after the end-of-run sync are missed. The notice says so.
- Redone runs are not counted as wasted (§2.3).

## 4. Alternatives not chosen

| Alternative | Why not |
|---|---|
| Count `succeeded_proposal_only` as wasted | An L1 run is told to produce a proposal; it did what G4 allowed |
| Count runs in progress as wasted | Most of them will succeed; the number would change after the run |
| Let `viewer` read cost | Cost is commercial data; viewers read intents, not budgets |
| Money as JSON numbers | Floats lose cents in sums (D-05 D6) |
| Build the scheduled sync in E04 | Changes the worker while E01 PR 2 runs in parallel |

## 5. Open items

| Item | Who / when |
|---|---|
| Scheduled spend sync (ADR-M24 §2.5) | Worker task, after E01 PR 2 (QUESTIONS #197) |
| Wasted tokens of redone runs (§2.3) | Later task, with gate history (M-E data report) |

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-10-04 | Claude (task E04) | First version |
