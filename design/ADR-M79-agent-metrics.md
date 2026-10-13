# ADR-M79. The agent efficiency report

| Item | Value |
|---|---|
| Status | **Proposed** (task V13, for review); §2.3 model attribution decided in QUESTIONS #434 (option C) |
| Date | 2026-10-12 |
| Decided by | Harry (plan approved 2026-10-12, with answers to QUESTIONS #430–#433) |
| Related | D-08 task V13; D-02 FR-12, FR-53; D-05 §6.3–§6.5; D-07 §5; ADR-M45 (cost report); ADR-M47 (gate metrics); ADR-M42 (kill switch, stop reasons); ADR-M26 §2.5; QUESTIONS #422, #430–#433 |

## 1. Context

Leadership will ask whether agents and models are worth their cost. The platform records runs and how they ended, gate decisions, `intent.closed` metrics and cost records, but no report brings them together. V13 adds `GET /v1/metrics/agents` and `sdlc metrics agents`, built from existing data only: **no new table, no migration, read only**.

## 2. Decision

### 2.1. Endpoint, command, shape

- `GET /v1/metrics/agents?project=&agent=&model=&from=&to=` and `sdlc metrics agents [--project <slug>] [--agent <key>] [--model <name>] [--from] [--to] [--json]`, the same shape as the cost report (ADR-M45) and the gate metrics (ADR-M47).
- One row per (project, agent key and version, model). Codes, counts, seconds and amounts only; never a person, a login, a title or a text. Money is a decimal string with 6 decimals; token sums are digit strings (D-05 D6). Sums are made in SQL.
- Range half-open UTC `[from, to)`, default the last 30 days, at most 366 days (400 `invalid_request` otherwise); at most 500 rows with `truncated`.

### 2.2. Who may read it (QUESTIONS #430)

A role in **both** `access.cost_read_roles` and `access.metrics_read_roles`; tenant admins always. The whole tenant: tenant admins only. No new config key, so stored configuration hashes do not change. No role on the project → 404 `project_not_found`; a role in only one list → 403 `forbidden`. `viewer` is never in either list (rules M28, M29).

### 2.3. What a row belongs to (QUESTIONS #432, #433)

- **Run measures** count under the run's agent key and version (`runs.agent_id`, `agent_version`) and the run's model. The run's contract holds only `allowed_models`, the set the policy allows, so the platform records the model used: **the run event `model_selected`**, written by `prepareRun` with the `model_ref` G4 bound into the run proposal (QUESTIONS #434, option C). A run without that event (runs from before it, or a name the event cannot hold) falls back to the model with the most cost among the run's cost records (ties by name); a run without either has the model `unknown`. A run's whole cost counts under that one model; the report does not split a run across models. A cost record that belongs to no run is left out of the rows and shown apart as `unattributed_cost_usd`.
- **Intent measures** (merged without a request for changes, lead time, cost per merged intent) count under the agent version and model of the run that was merged (the `pr_merged` run event). An intent that was not merged appears only in the run measures.

### 2.4. Measures

| Measure | Source |
|---|---|
| Runs by status; each stop reason | `runs.status`, `runs.stop_reason`; the runs created in the range |
| Retries | `runs.attempt` above 1 |
| CI on the first try at G6 | the first `ci_checked` run event of the intent, `state` `passed` or not, counted under the run that made it |
| Merged without a request for changes at G7 | the intent's last `pr_merged` event, with no G7 `request_changes` decision recorded before it |
| G5 scope breaches | G5 `fail` with reason `out_of_scope`, counted under the intent's latest run created before the decision |
| Lead time | `intent.closed` |
| Tokens and cost per run; cost per merged intent | `cost_records` (per merged intent: the whole cost of the intent, divided by the intents merged) |
| Wasted cost | runs that ended in `WASTED_RUN_STATUSES` (ADR-M45) |
| Cache share of input tokens | `cost_records.cached_input_tokens` / `input_tokens` |

A measure with no data is null, never 0. Runs still in progress are counted apart (`running`), never in a rate.

### 2.5. Where the code lives

`@sdlc/core` `metrics/agents.ts` (rules) and `AgentMetricsRepository` (queries, `TenantScope.agentMetrics`); `apps/api/src/metrics/`; the response schema in `@sdlc/api-schemas`; the CLI in `apps/cli/src/commands/metrics.ts` with catalog keys `cli.metrics.agents.*`.

## 3. Consequences

- No migration. The query plan is checked with `EXPLAIN ANALYZE` on a large seeded database, as E06 did; an index is a separate decision.
- The human-effort baseline (V13 AC4) moves to task V14 in Later (QUESTIONS #431), because it needs a write path and a column.
- The measures describe real work, not quality in a controlled test. Controlled comparison is L02 (ADR-M78).

## 4. Alternatives not chosen

| Alternative | Why not |
|---|---|
| A new config key `access.agent_metrics_read_roles` | Changes every stored configuration hash; the report only combines two existing audiences |
| The agent register's `model_ref` as the model | Holds only the current version's model (QUESTIONS #432) |
| The run contract's `allowed_models` as the model | A set of allowed models, not the one used (QUESTIONS #434) |
| Only the cost records (option A) | Misses runs without cost and a run's later model calls; kept as the fallback for older runs (QUESTIONS #434) |
| Credit an intent to the first or the latest run | The merged run is the one whose result was accepted (QUESTIONS #433) |
| A per-person breakdown | Ranks people; not needed (as ADR-M47) |

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-10-12 | Claude (task V13) | First version |
| 0.2 | 2026-10-13 | Claude (task V13), approved by Harry | §2.3: a run's model from the run event `model_selected`, the cost records as the fallback (QUESTIONS #434, option C) |
