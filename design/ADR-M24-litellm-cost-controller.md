# ADR-M24. LiteLLM adapter, keys from OpenBao, Cost Controller (part 1)

| Item | Value |
|---|---|
| Status | **Proposed** (task C03, PR for review) |
| Date | 2026-09-26 |
| Decided by | Harry (plan approved 2026-09-26, with answers D1–D5 and two additions) |
| Related | D-08 tasks C03, C12; D-02 FR-50, FR-51; D-03 sections 7.4, 8.2, 10; D-05 sections 6.5, 7.2; D-07 sections 3–6; ADR-M10 §4.2, ADR-M17, ADR-M19, ADR-M21, ADR-M09; QUESTIONS #1, #4, #14, #17, #197, #225 |

## 1. Context

Task C03 connects the platform to LiteLLM, the model gateway (D-07 section 3):

- LiteLLM gets the model provider keys from OpenBao, without a LiteLLM Enterprise licence (QUESTIONS #1, option B: an OpenBao Agent sidecar).
- The Cost Controller creates one virtual key per run, with a cost cap, a model list and the seven labels (tenant, project, intent_id, run_id, gate, agent, data_class). It revokes the key at the end of the run.
- A sync job copies spend from LiteLLM into `cost_records` (append-only, codes and numbers only).
- Over budget, the request is blocked (FR-51: tenant/month, intent, run).

All LiteLLM behaviour below was checked on the pinned image `ghcr.io/berriai/litellm:v1.102.1` (2026-09-26), and again on `v1.104.0` (2026-10-07, issue #177; the two changed facts are marked in §2.2). The live test (`pnpm test:litellm`) checks it again on every change.

## 2. Decision

### 2.1. Keys: OpenBao Agent sidecar, Compose profile `models` (D1, D2)

| Topic | Decision |
|---|---|
| Sidecar | Service `litellm-agent`: `bao agent` from the pinned OpenBao image (no new image). AppRole `litellm`, policy `policies/litellm.hcl`. No token sink on disk |
| What it renders | The whole LiteLLM configuration (`platform/deploy/litellm/config.ctmpl`) into `/run/litellm/config.yaml`, mode 600. The volume `litellm-config` is tmpfs (local driver, `type=tmpfs`): the file exists only in memory while the containers run |
| Values | Every key goes through `toJSON`, so no value can break the YAML |
| Provider keys | `kv/litellm/providers/<provider>`, field `api_key`. The template lists `kv/metadata/litellm/providers/` and adds a model only when its provider has a key. A missing provider key therefore never blocks start-up |
| Master key (D2) | One source: `kv/cost-controller/litellm-master-key` (A03). The `litellm` policy reads exactly that path; the sidecar renders it as `general_settings.master_key`. The Cost Controller reads the same entry |
| Salt key (D2) | `kv/litellm/salt-key`, rendered as `environment_variables.LITELLM_SALT_KEY` (LiteLLM sets it in its own process from the configuration; it is never a container environment variable) |
| Fail closed | `exit_on_retry_failure` and `error_on_missing_key`: without access, a master key or a salt key, the sidecar exits and LiteLLM does not start |
| Profile (D1) | The sidecar is in the new profile `models`. `core` is unchanged and still starts healthy on a fresh clone. LiteLLM has `depends_on: litellm-agent (service_healthy, required: false)`: with the profile, it waits for the rendered file; without it, it starts with `config.yaml` (no models) and the development keys from `.env`. **The server always runs with the profile** (`pnpm compose:models`, runbook T11 §5d) |
| Start-up | `litellm/start.sh` (the container entrypoint). Rendered file present → `unset LITELLM_MASTER_KEY LITELLM_SALT_KEY`, use the file. Absent → require a development `LITELLM_MASTER_KEY`, use `config.yaml`. LiteLLM never starts without a master key |
| `.env` | `LITELLM_MASTER_KEY` and `LITELLM_SALT_KEY` are optional (`${VAR:-}`), for development without the profile only. On the server they stay empty. A static test allows exactly these two exceptions to the `${VAR:?}` rule |
| Credentials of the sidecar | `bootstrap.sh litellm-credentials`: asks for an admin token (hidden), issues a secret ID for `litellm`, and pipes role ID and secret ID from the openbao container straight into the volume `litellm-approle` (mode 600) through `docker compose run` of the sidecar. No host file, no command-line argument, nothing printed |
| Rotation | Provider or master key: store the new value; the sidecar re-renders; restart LiteLLM. Secret ID: run `litellm-credentials` again, restart the sidecar. Salt key: never (runbook T11 §5d) |

The secret ID file lives on a named Docker volume (on disk, readable by root only), not on tmpfs: the sidecar must log in again after a server restart without an operator. OpenBao itself needs two key holders after a restart anyway (D-03 §10.2).

### 2.2. LiteLLM API facts (v1.104.0, checked live)

| Fact | Consequence |
|---|---|
| `POST /key/generate` returns the key and its hash (`token`). `/key/delete` and `/key/info` accept the hash | `VirtualKey.keyId` is the hash; the raw key is never sent back to LiteLLM by the platform |
| Deleting an unknown key or updating an unknown team answers with an error whose body holds `"code": "404"` (not always HTTP 404) | The adapter treats that as "not found" |
| Spend logs do **not** contain the key's metadata. They contain the key's `metadata.tags` as `request_tags` on every call | The labels are set twice on the key: as metadata fields (key info, Langfuse) and as tags `<label>:<value>` (every spend row). The sync reads the tags |
| `GET /spend/logs/v2` pages (`page`, `page_size`, `total_pages`); dates are `YYYY-MM-DD HH:MM:SS` UTC, whole seconds | The adapter widens the range to whole seconds, then keeps `[from, to)` exactly |
| `request_id` is the provider's response ID for a successful call and a UUID for a failed one; `model_group` is the name the caller asked for | `source_ref` = `request_id`; `model` = `model_group` (the name in `allowed_models`) |
| Cached tokens: `metadata.usage_object.prompt_tokens_details.cached_tokens` | `cached_input_tokens` |
| Team `budget_duration: 1mo` resets at 00:00 UTC on the first day of the next month | The tenant budget period is the UTC calendar month (D3) |
| `/model/info`, `/v1/models`, `/model_group/info`, `/key/info`, `/team/info` and the other admin endpoints do not return provider keys, the master key or the salt key | Checked by the live test (addition 1) |
| Spend is updated asynchronously; a key can go about one call over its budget (QUESTIONS #14) | The key and team budgets are a backstop. G5 (C07) reads `cost_records` |
| Custom prices without a cache price: cached input tokens cost the normal input price (v1.104.0, BerriAI/litellm#41832; on v1.102.1 they cost 0). An explicit `cache_read_input_token_cost: 0` still makes them free | Budgets and spend count every input token. Set a cache price in the price table of a self-hosted model only when its cache really is cheaper |
| A call over a key, team or user budget is refused with HTTP **422** and `error.type` `budget_exceeded` (v1.104.0, BerriAI/litellm#42097; on v1.102.1 it was 429). Real rate limits (rpm, tpm) stay 429. `litellm_settings.budget_exceeded_status_code: 429` would restore the old code; the platform does not set it (issue #177) | A budget block is recognised by the status **and** the error type, never by 429 alone. Nothing in the platform reads the status: the runner's budget stop (C07, ADR-M34 §2.6) reads the key's spend, and an agent that fails on the refusal is re-checked against the spend and ends `stopped_budget` / `max_budget`. The agent no longer retries a refused call |

### 2.3. Budgets at three levels (FR-51, D3, addition 2)

| Level | Where | How |
|---|---|---|
| Run | LiteLLM key `max_budget` | The Run Contract's `max_budget_usd` |
| Intent | Cost Controller | Cap = what is left of `intents.budget_usd` after its `cost_records`. Zero or less → `CostError('intent_budget_exhausted')`, no key |
| Tenant / month | LiteLLM team per tenant + Cost Controller | Team `sdlc-tenant-<slug>` (fixed ID, created or updated at each `issueRunKey`), `max_budget` = `tenants.monthly_budget_usd`, `budget_duration: 1mo`. The key is also capped at what is left of this UTC month in `cost_records`. Zero or less → `tenant_budget_exhausted`. A `null` budget: no team cap, warning `cost.tenant_budget_unset` |

The key's cap is the smallest of the three; `limitedBy` says which one set it. Money is handled as decimal strings and integer micro-dollars, never floats (D-05 D6). The key lives for the contract's start window plus `max_duration_min`.

### 2.4. Labels (D4)

The seven D-07 labels, with the values of the D-07 examples: tenant slug, project slug, intent code (`INT-…`), run UUID, gate code, agent key, data class. Values are codes (`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$`): no spaces, no `@`. The Cost Controller builds them from the database, not from the caller; only `gate` and `agent` come from the caller, and both are checked.

### 2.5. Spend sync (AC4, D5)

- `CostController.syncSpend({from, to})` reads the gateway's call records and the model list, finds tenant and run from the labels, checks that the intent code and project slug match the run, and inserts with `ON CONFLICT (tenant_id, source_ref) DO NOTHING`. Running it again on the same range inserts nothing.
- A call that cannot be recorded is counted by reason (`no_usage`, `unlabelled`, `unknown_tenant`, `unknown_run`, `label_mismatch`, `unknown_model`, `invalid_record`, `unreadable`) and logged; the reasons that lose cost data are logged as a warning. A gateway row the adapter cannot read (for example a negative cost) is counted as `unreadable`; it never stops the sync of the other rows. An answer without `total_pages` is an error, so paging never stops early without notice. A label for one tenant never finds a run of another tenant.
- `endRun` revokes the key first, then syncs once.
- ~~Scheduling belongs to the worker (B07 / C07): a Temporal schedule that calls `syncSpend` with a look-back window, because LiteLLM writes spend logs in batches.~~ **Changed in version 0.2 (task C12, QUESTIONS #197, #225):** scheduling is a plain loop in the worker process (`CostSyncLoop`, `apps/worker/src/cost-sync-loop.ts`), like the GitHub poller and the escalation clocks (ADR-M27, ADR-M28), not a Temporal schedule. As built:
  - **When:** one pass at start, then every `SDLC_WORKER_COST_SYNC_INTERVAL_SECONDS` (default 300, 30–3600) after the previous pass ended. The run-end sync (`endRun`, `endRunKey`, also after a kill) stays.
  - **Range:** each pass syncs `[from, now)`. Normally `from = now − SDLC_WORKER_COST_SYNC_LOOKBACK_MINUTES` (default 120, 10–1440, at least two intervals): calls LiteLLM writes late, in batches, are recorded by a later pass. The first pass after a start reads `SDLC_WORKER_COST_SYNC_CATCH_UP_MINUTES` back (default 1440, from the look-back up to 10080): the time the worker was down.
  - **Once more after each run ends:** `from` also reaches back to the start of every run, of any tenant, that ended within `SDLC_WORKER_COST_SYNC_SETTLE_MINUTES` (default 30, 5–1440; `SystemScope.earliestStartOfRunsEndedSince`), never further than the catch-up window. So a run longer than the look-back is read whole once more within one interval after it ends. A run in progress shows its spend within one interval.
  - **Slices and the page cap:** the range is read in slices of 60 minutes, oldest first. `listSpend` fails with `truncated` when a range has more pages than its cap (1000 pages): it never returns part of a range as if it were all of it.
  - **Failures (D-08 C12 AC3):** a slice that fails (gateway down, `truncated`, database error) fails the pass; the slices before it are recorded. The next pass starts at the failed slice, however old, but never earlier than `now − catch_up`. A range cut at that limit is logged as `worker.cost_sync_gap` with `uncovered_minutes`: an operator must sync that range by hand (open item below). Each pass logs `worker.cost_synced` (window, slices, seen, inserted, duplicates, `skipped_<reason>` counts) or `worker.cost_sync_failed` (an error code, slices done). The loop never throws and never stops the worker or a run.
  - **One sync at a time:** `SystemScope.withSpendSyncLock` takes a session advisory lock (`pg_try_advisory_lock`) on one reserved connection, without waiting; a second process skips the pass (`worker.cost_sync_busy`). A process that dies releases the lock with its session. Inside one process, passes never overlap.
  - **Who:** the loop uses the worker's Cost Controller, so it runs only when the `cost-controller` AppRole is delivered (ADR-M33 §2.5). Without it the worker logs `worker.cost_sync_off` and starts no runs either.
  - **Late records and G8 (E03):** cost records that arrive after an Evidence Pack was built change its content and so the G8 `release_sha256`, which voids a G8 approval. With the run-end sync and a pass at most one interval after the run ends, a run's records are complete long before G8: G5's block window, G6 CI and a G7 review and merge come between. Only a gateway outage across the G8 decision can void it, and then asking G8 again is the right result: the pack must show the real cost. G8 is not changed.

### 2.6. `cost_records` (migration `0005-cost-records`)

As D-05 §6.5, with: `id` identity; composite foreign keys to `projects`, `intents`, `runs`; `run_id` needs `intent_id`; `cached_input_tokens ≤ input_tokens`; CHECKs on `model`, `agent`, `source_ref` (codes) and `provider_type`; unique `(tenant_id, source_ref)`; the D-05 §9 indexes plus `(tenant_id, occurred_at)` for month totals. Append-only: `forbid_mutation()` triggers for UPDATE, DELETE and TRUNCATE; `platform_app` has `SELECT, INSERT` only.

### 2.7. `ModelGateway` (`@sdlc/contracts`) compared with D-03 §7.4

Same responsibilities. Differences:

- `createRunKey` takes `maxBudgetUsd` as a decimal string (D-05 D6), `durationMinutes` and `tenantGroupId`.
- New `ensureTenantBudget` (the tenant team, FR-51).
- New `listModels()` → `{model, providerType}[]`: the model list the policy engine needs (QUESTIONS #17). A model without `model_info.provider_type` is left out, so policy never routes to it.
- New `listSpend(range)` for the sync: the records plus the number of rows it could not read.

### 2.8. Tests

| Where | What |
|---|---|
| `pnpm test` | `tests/cost/` (adapter against an in-process LiteLLM stand-in; money; messages), `tests/db/cost-records-sql.test.ts`, `tests/deploy/litellm-static.test.ts` (sidecar, template, no key outside OpenBao, `start.sh`), OpenBao policy tests |
| `pnpm test:db` | `tests/integration/db/cost.test.ts`: Cost Controller with a fake gateway on PostgreSQL (caps, refusals, sync, append-only, tenant isolation) |
| `pnpm test:litellm` | `tests/integration/litellm/litellm-live.test.ts`: throw-away Compose project like the server (profile `models`, empty `.env` keys), OpenBao bootstrapped, a stub model that accepts only the provider key stored in OpenBao. AC1–AC5 and addition 1. CI `compose` job |

## 3. Open items

| Item | Where |
|---|---|
| ~~Schedule `syncSpend` in the worker~~ Done (C12, §2.5) | C12 |
| A manual spend sync for an operator after `worker.cost_sync_gap` (a range older than the catch-up window): no command yet; meanwhile raise `SDLC_WORKER_COST_SYNC_CATCH_UP_MINUTES` (at most 10080) and restart the worker | Later operator task |
| G5 budget checks from `cost_records` (80 % warn, 100 % stop) | C07 |
| Kill switch revokes the virtual key | C11 (uses `revokeKey`) |
| LiteLLM traces to Langfuse (`langfuse_otel`) | A08, QUESTIONS #4 (open) |
| TLS between the sidecar and OpenBao (`BAO_ADDR` becomes `https://`, CA file) | A10 |
| The LiteLLM database password still comes from `.env` (NFR-03 allows it) | Deployment of the platform processes |
| The real Claude model entry in `config.ctmpl` uses LiteLLM's built-in prices; the real run is still pending | ADR-M10 §3, QUESTIONS #15 |

## 4. Alternatives not chosen

| Option | Why not |
|---|---|
| LiteLLM's Vault secret manager | Enterprise feature (QUESTIONS #1) |
| Provider keys in `.env` | Refused (QUESTIONS #1) |
| Sidecar renders an env file that LiteLLM sources | Shell-sourcing key values is fragile; `os.environ/` would still need the values in the process environment |
| Models and keys stored in LiteLLM's database (`STORE_MODEL_IN_DB`) through the API | Keys would live in a second store, encrypted with the salt key |
| Master key in `.env` for LiteLLM and in OpenBao for the Cost Controller | Two sources can drift (D2) |
| Sync by key (`/spend/logs?api_key=`) | Needs one call per key; the date range with tags covers all runs in one paged read |
| Sidecar in `core` | `core` would no longer start on a fresh clone before OpenBao is set up (D1) |

## 5. Consequences

- New AppRole `litellm` (`bootstrap.conf`, `policies/litellm.hcl`): run `configure` again on existing installations, then `litellm-credentials`.
- New command `pnpm compose:models`; `pnpm compose:down` also stops the profile `models`.
- New commands `pnpm test:litellm` and `pnpm openbao:bootstrap litellm-credentials`.
- `@sdlc/core` exports `CostController`; the worker (B07/C07) and the runner (C04/C05) wire `LiteLLMGateway` with the master key read through `SecretReader`.

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-09-26 | Claude (task C03) | First version |
| 0.2 | 2026-10-04 | Claude (task C12), approved by Harry | §2.5: the scheduled sync as built: a worker loop instead of a Temporal schedule, look-back and catch-up windows, runs that just ended, slices, `truncated`, failures and the gap warning, the lock, G8; §3: open items (QUESTIONS #197, #225) |
| 0.3 | 2026-10-07 | Claude (issue #177, PR 1), approved by Harry | §1, §2.2: checked again on LiteLLM v1.104.0: a budget block answers 422 with `budget_exceeded` (was 429), kept as the upstream default; cached input tokens without a cache price cost the input price (was 0) |
