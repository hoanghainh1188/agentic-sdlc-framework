# ADR-M47. Gate waiting-time metrics

| Item | Value |
|---|---|
| Status | **Proposed** (task E06, for review) |
| Date | 2026-10-04 |
| Decided by | Harry (plan approved 2026-10-04, with answers to QUESTIONS #205–#207) |
| Related | D-08 task E06 (AC1); D-02 FR-12, §14; D-05 §6.2 (`gate_entered_at`), §6.3 (`waited_seconds`); ADR-M30 §2.4, §2.9; ADR-M45 (the cost report, same shape); ADR-M26 §2.5; ADR-M37 §2.5; QUESTIONS #205–#207 |

## 1. Context

D-02 FR-12 asks for the waiting time of human gates "recorded as a metric", and §14 asks to "measure waiting time per gate" to check that the 8 gates do not slow people down. D-08 E06 AC1: `sdlc metrics gates` shows the average and maximum waiting time per gate, per project.

What existed before E06:

- `gate_decisions.waited_seconds` (B07 session 2): the decision time minus `intents.gate_entered_at`, wall-clock seconds. It is written on people's decisions at the current gate (CLI, API, comments, G7 reviews) and on the platform's decisions (HOTL pass, G4 POLICY pass, G5 and G6 pass and fail). It is null on a block of a passed gate.
- `intents.gate_entered_at`: when the intent entered its current gate. **A request for changes does not restart it** while the intent stays at the gate; only the overdue deadline clock restarts (ADR-M30 §2.9).
- The audit chain orders decisions and moves of one intent exactly (`seq`, ADR-M30 §2.4).

## 2. Decision

### 2.1. Endpoint and command (AC1)

- `GET /v1/metrics/gates?project=&gate=&mode=&risk=&from=&to=` and `sdlc metrics gates [--project <slug>] [--gate G1..G8] [--mode HITL|HOTL|AUDIT|POLICY] [--risk low|medium|high|critical] [--from] [--to] [--json]`.
- One row per (project, gate). Without `project`: the whole tenant, still one row per project and gate.
- **Never a breakdown per person.** It would rank approvers; the report holds codes, counts and seconds only.

### 2.2. What counts (QUESTIONS #205)

| Decision | Counted as |
|---|---|
| A person's `approve`, `reject` or `request_changes` with `waited_seconds` (G7 reviews included; each approval of a dual approval counts) | **Finished wait** |
| A block of a passed gate (`waited_seconds` null) | Left out |
| The platform's `pass` in HOTL or AUDIT mode at G1–G3, G7, G8 | `auto_passed`, a count only |
| G4 POLICY, the platform's G5 and G6 decisions, `void` | Left out: nobody was waited for |

- The value is the stored `waited_seconds`: the time since the intent entered the gate (FR-12, option A).
- **Two groups, never mixed:**
  - **first round**: no request for changes at the same gate earlier in the same visit. This is the clean "waiting for a person" number;
  - **after changes**: a request for changes at the same gate was recorded earlier in the same visit. The value includes the producer's rework.
- A **visit** starts where the clock of `waited_seconds` (`gate_entered_at`) starts: at the first `intent.state_changed` event into the gate after the last move to another gate (or to no gate). "Earlier" is by audit `seq`.
  - When an intent goes back to a gate (a return after a block, G5 → G3, G7 → G4), it is a new visit and a new first round. A block of a passed gate is recorded while the intent waits at a later gate, so it belongs to no visit of that gate.
  - A pause and resume at the same gate (an escalation) is not a new visit: `gate_entered_at` keeps running, so a decision after a request for changes stays "after changes".
- **Why not measure from the last request for changes (option B).** The time from a request for changes to the next decision still includes the rework, so it is not more exact. Splitting the groups keeps the first round clean and shows the rework apart.
- For each group: count, average (rounded to whole seconds), maximum, median and p90 (`percentile_disc`, whole seconds), computed in SQL. Null values when the count is 0, never 0 seconds.
- **Wall-clock time**, as stored, never working hours. The CLI says so on every output; `--json` has `clock: "wall_clock"`.
- Known limits of the stored value: a G7 review is recorded when the poller reads it, so its wait includes the polling delay (ADR-M41); an approval voided later (expiry, a changed input) still ended a wait and stays counted, and the decision after the void counts too.

### 2.3. Intents at the gate now (QUESTIONS #207)

- Per (project, gate): the number of intents `in_gate` now and the oldest wait (now − the earliest `gate_entered_at`). Every gate: G4 at High risk and G6 in HITL mode also wait for a person.
- Labelled "at the gate", not "waiting for a person": at G4 to G6 an intent may wait for a run or for CI. Never mixed into the statistics; the range and `--mode` do not apply (a mode belongs to a decision).
- **Gap:** the step's wait reason (`decision`, `later_gate`, `frozen`…) is returned to the workflow and not stored, so the platform cannot tell "waiting for a person" cheaply. A later task can store it if the M-E data needs it. Closed for the current wait by U02: the step records it on the intent (`intents.waiting_reason`, ADR-M54 §2.4b); its history is still not kept.

### 2.4. Range, filters and limits

- The range selects decisions by the time of their `gate.decided` audit event (the registry clock, the same clock as `gate_entered_at`, ADR-M30 §2.9). UTC, half-open `[from, to)`, the same time formats as the cost report (ADR-M45 §2.4). **Default: the last 30 days** (a wait does not belong to a budget month); at most 366 days; empty or longer → 400 `invalid_request` (`query.to`, `range_empty` / `range_too_long`).
- Filters: `gate`, `mode` (the oversight mode recorded with the decision), `risk` (the intent's risk tier). Unknown values → 400.
- At most **500 rows**, sorted by project slug then gate, with `truncated`. The queries are grouped, so their size grows with projects × gates, not with the number of decisions.

### 2.5. Who may read them (QUESTIONS #206)

- The whole tenant: **tenant admins only** (403 `forbidden` for anyone else).
- One project: a tenant admin, or a role in new project config **`access.metrics_read_roles`**, default `[person_a, person_b, second_approver, pm_brse, governance, admin]`.
- **Mandatory rule M29:** `viewer` is never in `access.metrics_read_roles`. A viewer (later perhaps the client) reads single intents, but the team's responsiveness is internal data.
- No role on the project → 404 `project_not_found`; another role → 403 `forbidden` (ADR-M26 §2.5).
- A separate key from `access.cost_read_roles`: cost is commercial data with another audience.

### 2.6. Tenant isolation and indexes

- Every query goes through `TenantScope`; `gate_decisions`, `intents`, `projects` and each `audit_log` occurrence (the decision's own event, the entry, the earlier request for changes) carry `tenant_id = <tenant>` (D-05 D2, the tenant guard).
- **No migration.** `EXPLAIN ANALYZE` on a throw-away database with 10,000 intents, 40,000 decisions and 120,000 audit events: the finished-wait query takes about 50 ms, the other two under 3 ms. The decision's own event, the visit's start and the earlier request for changes use the existing index `audit_log (tenant_id, entity_id, seq)`; open waits use `intents (tenant_id, project_id, status)`. The range filter on `audit_log.occurred_at` reads the tenant's audit events in one scan; an index on (`tenant_id`, `action`, `occurred_at`) can be added if a tenant's audit log grows far beyond this.

### 2.7. Where the code lives

| Part | Where |
|---|---|
| Config key and rule M29 | `@sdlc/config` (`schema.ts`, defaults, `mandatory-rules.ts`); type in `@sdlc/contracts` |
| Queries | `GateMetricsRepository` (`waitStats`, `autoPasses`, `openWaits`) in `@sdlc/core`, `TenantScope.gateMetrics` |
| Rules (access, range, merge) | `@sdlc/core` `metrics/gates.ts` (`buildGateMetrics`) |
| API | `apps/api/src/metrics/` |
| CLI | `apps/cli/src/commands/metrics.ts`, schema in `api/schemas.ts`, catalog `cli.metrics.*` |

## 3. Consequences

- The new default `access.metrics_read_roles` changes the hash of every stored project configuration. At start, the api and the worker re-hash a configuration whose YAML is unchanged (B13 AC8, ADR-M37 §2.5); a test covers a configuration stored before E06.
- "After changes" values are long by nature (they include the rework); read the first round for the approvers' waiting time.
- The open waits at G4 to G6 include intents that wait for a run or for CI.

## 4. Alternatives not chosen

| Alternative | Why not |
|---|---|
| Measure from the last request for changes (option B) | Still includes the rework; needs a derived clock (#205) |
| Mix HOTL passes into the statistics | Near-zero values would hide the human waits |
| Reuse `access.cost_read_roles` or `access.intent_read_roles` | Another audience; `intent_read_roles` includes the viewer |
| Show open waits only at G1–G3, G7, G8 | G4 High and G6 HITL also wait for a person (#207) |
| A breakdown per approver | Ranks people; not needed for FR-12 |
| Working hours instead of wall-clock time | `waited_seconds` is stored as wall-clock time (FR-12, B07) |

## 5. Open items

| Item | Who / when |
|---|---|
| Store the step's wait reason, to tell "waiting for a person" at G4–G6 (§2.3) | Later task, if the M-E data needs it |
| Index on `audit_log (tenant_id, action, occurred_at)` (§2.6) | Only when a tenant's audit log is far larger than the measured case |

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-10-04 | Claude (task E06) | First version |
