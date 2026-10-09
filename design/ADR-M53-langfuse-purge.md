# ADR-M53. Purge a project's data from Langfuse

| Item | Value |
|---|---|
| Status | **Proposed** (task E08, for review) |
| Date | 2026-10-05 |
| Decided by | Harry (E08 plan approved 2026-10-05: D1 = A, D2 = B, D3 = A, D4; QUESTIONS #250–#253) |
| Related | D-08 task E08 (AC1–AC4); D-02 FR-44, §10; D-03 §5.2, §8.2, §10 (version 1.31); D-05 §6.6, §10.1 (version 1.35); ADR-M24 §2.2 (labels as tags), ADR-M35 (the collector, Langfuse v4, client data), ADR-M51 (retention, §2.6, §4), ADR-M52 (SeaweedFS access); runbook T11 §5j, §5m; QUESTIONS #238, #250–#253 |

## 1. Context and spike result (AC1)

LiteLLM sends every model call to Langfuse with the seven labels as trace tags `<label>:<value>` (ADR-M35 §2.4, ADR-M24 §2.2). The traces hold the prompts and responses: client data. FR-44 asks that archiving a project purges its client data, and evidence retention (ADR-M51) deletes evidence files after `evidence_retention_days`. Until E08 the Langfuse traces were deleted by hand (QUESTIONS #238; `project.purged` recorded `langfuse: manual`).

The spike ran on a throw-away stack with the pinned images: Langfuse 4.47.0 in `events_only` mode, ClickHouse 26.3.36.6, SeaweedFS 4.48. It also read the Langfuse source at the tag `v4.47.0`.

| Question | Result (checked live) |
|---|---|
| Can a trace be deleted in `events_only` mode? | Yes. `DELETE /api/public/traces` (`{"traceIds": [...]}`, at most 1,000) is accepted; only the legacy GET and POST are refused in this mode. |
| Immediate or asynchronous? | **Asynchronous.** Langfuse records a pending deletion and its worker deletes after `LANGFUSE_TRACE_DELETE_DELAY_MS` (5 s). Measured: gone from the read API after about 7 s. |
| How to select one tenant's project? | `GET /api/public/v2/observations` with `filter=[{"type":"arrayOptions","column":"tags","operator":"any of"\|"all of","value":[...]}]` and `fields=core,metadata`. `all of [tenant:a, project:p1]` returned exactly that project's trace, with two tenants in the same data. Each observation returns its trace's full tag list in `metadata["attributes.langfuse.trace.tags"]`. A filter Langfuse cannot read (bad JSON, unknown column) is refused with 400: it never answers without the filter. |
| What does the delete remove? | ClickHouse `events_full` and `events_core` with a **lightweight `DELETE`**: the rows are hidden at once but stay on disk (`SETTINGS apply_deleted_mask = 0` still shows them) until a merge. The tables are partitioned by month, so an old partition may never be merged again. `ALTER TABLE … APPLY DELETED MASK` removed them from disk. `observations_batch_staging` has a 48-hour TTL. Postgres keeps trace IDs only (`pending_deletions`); LiteLLM uploads no media. |
| Does it delete the files in SeaweedFS? | **No.** Langfuse keeps every OTLP request as one file, `langfuse/events/otel/<langfuse project>/<yyyy/mm/dd/hh/mm>/<uuid>.json`, and does not record these files anywhere (its source has a TODO about it), so the trace delete never touches them. **One file holds the whole batch**: the collector batches spans, and in the spike one file held the prompts and responses of two tenants and two projects. These files cannot be deleted per project. |
| Data access window | Langfuse clamps reads to a "data access window" by plan; for OSS (`oss`) there is none (`data-access-days: false`, source). The adapter asks from 1970 on anyway. |

**Conclusion:** the per-project delete through the API is reliable. Two more steps make it complete: an age-based sweep of the raw OTLP files for every tenant (D1), and `APPLY DELETED MASK` so the deleted rows leave ClickHouse's disk (D2).

Langfuse "projects" are not our projects: one Langfuse project (`sdlc-platform`) holds every tenant's traces. The tags tell them apart.

## 2. Decision

### 2.1. Where it runs

A step of the worker's retention pass (`runRetentionPass`, ADR-M51 §2.8), under the same advisory lock and in the same mode (`SDLC_WORKER_RETENTION_MODE`: `report` counts, `purge` deletes):

- per tenant, after the evidence purge and before an archived project can be complete (`langfuseTenantPass`, core `retention/langfuse-pass.ts`);
- once per pass, after every tenant: the raw file sweep and the compaction (`langfuseFinish`).

It needs the retention loop (`worker-purge`) to run. Langfuse is behind an interface: `LlmTraceStore` (`@sdlc/contracts`), implemented by `LangfuseTraceStore` in the new adapter `@sdlc/adapter-traces-langfuse` (plain `fetch`, no new library). Core never imports the adapter.

### 2.2. When, and what is selected

- **The same rules as the evidence** (`retention/rules.ts`, ADR-M51 §2.2, §2.4): an intent's traces are purged when its evidence may be purged. One clock per intent, from its end (`intents.updated_at` of a finished intent): the project's `retention.evidence_retention_days` with the 180-day code minimum, or an archived project after its grace period. Never open intents; never held intents. A configuration that cannot be loaded purges nothing for retention. Traces are always older than their intent's end, so they need no clock of their own.
- **Three decisions**, as for evidence: the database selection (finished, ended at or before the cut-off, not held, no confirmed Langfuse purge), the rules, then the rules again under the intent lock with fresh facts.
- **Selection by our own run IDs**, never by slugs: the worker reads the intent's runs from the database and asks Langfuse for the traces tagged `run_id:<uuid>` (chunks of 50 tags, every page).
- **The tag check before every delete** (`traceBelongs`): each trace must carry exactly one `tenant:`, `project:`, `intent_id:` and `run_id:` tag, and they must be this tenant's slug, this project's slug, this intent's code and one of its runs. One trace that does not match: **nothing of the intent is deleted** (`retention.langfuse_tag_mismatch`, counted); the intent waits and an operator looks.
- **Slugs** (Harry's question): tenant and project slugs cannot be renamed today. `platform_app` has no UPDATE grant on `tenants.slug` or `projects.slug` (migration 0001), only the migration owner could change them. If a slug were ever renamed, the traces of older runs would carry the old slug: they would be refused by the tag check, never deleted wrongly, and the intent's purge would wait. An operator would then delete them by hand (runbook T11 §5j, by the run tags) and the intent's next pass confirms. A test shows a renamed slug never leads to a deletion.
- **The per-intent guard:** more than `MAX_TRACES_PER_INTENT` (5,000) traces for one intent: nothing is deleted (`retention.langfuse_guard_tripped`). An intent has a few runs of at most a few hundred model calls each.
- **The tenant guard** (review of E08): Langfuse has no object lock or legal hold to undo a wrong delete. So the evidence guard (ADR-M51 §2.4, `SDLC_WORKER_RETENTION_GUARD_*`) also counts the intents due for retention against the tenant's finished intents (`retention.langfuse_tenant_guard_tripped`); and when the evidence guard of the tenant tripped in the same pass, only archive purges run in Langfuse too.
- **No starvation** (review of E08): candidates come never-requested first, then by the oldest request; an intent that fails the tag check or the per-intent guard is set aside for 24 hours in the process, so a few stuck intents never block the rest of a project.
- **The key's project is checked first** (review of E08): an empty selection is taken as "deleted" only when Langfuse is reachable and the worker's key belongs to the project the collector writes to (`GET /api/public/projects` = `SDLC_WORKER_LANGFUSE_PROJECT_ID`, Compose: `LANGFUSE_INIT_PROJECT_ID`). Otherwise the pass logs `retention.langfuse_project_mismatch` or `retention.langfuse_unavailable` and runs no Langfuse step, no raw sweep and no compaction: a key of another project would find nothing and confirm every purge for ever.
- Platform spans (`sdlc-api`, `sdlc-worker`) carry no labels and hold IDs and codes only (ADR-M35 §2.5): out of scope.

### 2.3. Request, then confirm (D4, QUESTIONS #253; migration 0024)

- In `purge` mode the worker finds and checks the intent's traces under the intent lock and records the request in that transaction: a row in `langfuse_purges` (one per intent: `cause`, `traces`, `attempts`, `requested_at`, `last_requested_at`, `confirmed_at`) and the audit event `langfuse.purge_requested` (counts and the cause). The delete is sent after the commit (review of E08): a recorded request always has its audit event; a failed delete is asked again on the next pass, and never ends in a confirmation without a request.
- A later pass selects again. None found: `confirmed_at` is set once and `langfuse.purged` is audited. Still found (Langfuse's worker down): asked again, `attempts` grows, `retention.langfuse_purge_pending` is logged.
- An intent without traces (no run, or observability never on) is confirmed at once, without a call to delete.
- A confirmed purge never changes, and rows are never deleted (trigger `SDA17`, grants). Without the table the loop would ask Langfuse about every finished intent on every pass.
- Langfuse unreachable: the pass logs `retention.langfuse_failed` with a code and records nothing; the next pass tries again.

### 2.4. The raw OTLP files (D1, QUESTIONS #250)

- The worker sweeps `langfuse/events/otel/` by age, **for every tenant**: files whose last change is older than `SDLC_WORKER_LANGFUSE_RAW_MAX_AGE_HOURS` (24, at least 1) are deleted, at most `SDLC_WORKER_LANGFUSE_RAW_BATCH` (2,000) per pass, oldest key first. `report` mode counts only.
- The files mix tenants and projects (§1), so a per-project delete is not possible. Langfuse needs a file only while it ingests it; its retries end within minutes.
- **Langfuse's ingestion replay of older files is given up.** Replay is an admin repair tool we do not use.
- The SeaweedFS identity `worker-langfuse`: `List:langfuse` and `Write:langfuse/events/otel/*` (SeaweedFS `Write` includes delete), **never `Read`**. Checked live: a read of a raw file, a delete under `media/` and a list of `evidence` are refused (403). The bucket `langfuse` is not versioned, so a delete removes the file. The store is E05's `S3RetentionStore`, limited to the one prefix.
- With the 180-day minimum and the 7-day archive grace, a purged intent's raw files are always long gone; the sweep keeps every raw copy younger than a day.
- The sweep runs only in a pass where Langfuse answered (§2.2): a Langfuse that cannot be reached may not have ingested its files yet. After an outage longer than the maximum age, files it never ingested could still be deleted (accepted: the traces are lost for Langfuse, no client data stays).

### 2.5. ClickHouse disk (D2, QUESTIONS #251)

- After a pass that confirmed a purge of an intent with traces, at most once per UTC day, the worker runs `ALTER TABLE default.events_full APPLY DELETED MASK` and the same on `events_core` (`mutations_sync=1`), and logs `retention.langfuse_compacted` with its duration. The day and "owed" live in the process; after a restart an owed compaction waits for the next confirmed purge (runbook T11 §5j gives the manual command).
- It runs as the ClickHouse user `sdlc_purge`, which has only `ALTER DELETE` on those two tables. Checked live: `ALTER UPDATE` is not enough for `APPLY DELETED MASK`; `sdlc_purge` cannot `SELECT` (code 497); a wrong key gets 403.
- **Gap:** `ALTER DELETE` also allows `ALTER TABLE … DELETE WHERE …`, so this user could delete every row of the two tables (never read them). The credential lives only in `kv/worker/langfuse`.
- The adapter knows the two table names of Langfuse 4.47.0. A Langfuse upgrade that renames them fails the live test (`pnpm test:observability`). Checked again on Langfuse 4.50.0 with ClickHouse 26.3.39.7 (issue #177): the same tables, API and tag filter; the live test passes.
- To create the user, ClickHouse's admin user `langfuse` (already the owner of every Langfuse table) gets access management: `CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1`. ClickHouse masks the password in its query log (checked live). **Superseded by ADR-M63 §6 (A10):** a loopback-only user `sdlc_admin` makes `sdlc_purge`; `langfuse` has no access management.

### 2.6. The key and the credentials (D3, QUESTIONS #252; AC2)

- **One OpenBao entry, `kv/worker/langfuse`**, readable only by the `worker` AppRole (`kv/data/worker/*`; no policy change):
  - `langfuse_public_key`, `langfuse_secret_key`: **a second Langfuse project key for the worker**, made once by an operator in the Langfuse UI (project settings). Langfuse OSS creates keys through its API only with an organisation key, an Enterprise feature;
  - `clickhouse_password` of `sdlc_purge`;
  - `access_key`, `secret_key` of `worker-langfuse`.
- `pnpm openbao:bootstrap worker-langfuse-credentials` reads the admin token and the Langfuse key from hidden prompts (or stdin), makes the ClickHouse password and the S3 key inside the openbao container, stores the entry, applies the SeaweedFS identity and the ClickHouse user, and checks both (the user's grants exactly). Secrets pass through pipes only; the command prints no secret. Run it again to rotate the S3 key and the password (the Langfuse key is asked again), then restart `sdlc-worker`. Runbook T11 §5m.
- **The collector keeps its own key** (Langfuse's init key, from `.env`; A10 moves it to OpenBao, ADR-M35 §4).
- **Gap: Langfuse OSS keys have no scopes.** The collector's key could also delete traces; the worker's key could also read prompts and ingest. The worker never asks for input or output fields; the separate key can be revoked on its own.
- The live test uses the init key as the worker's key.

### 2.7. Not deployed, unavailable, and `project.purged`

| Worker state | Meaning | Langfuse purge | `project.purged` of an archived project |
|---|---|---|---|
| `SDLC_WORKER_LANGFUSE_URL=off` (default) | Not deployed | none | written; `langfuse: not_deployed` |
| URL set, entry missing or incomplete | Unavailable (`worker.langfuse_missing` at start) | none | **waits** (`retention.project_purge_waits_langfuse`) |
| URL set, entry complete | On | runs | waits until every finished, not held intent of the project is confirmed; `langfuse: purged` |

- `up.sh` sets `SDLC_WORKER_LANGFUSE_URL=http://langfuse-web:3000` when the profile `observability` is in the same call, **or when the project's ClickHouse volume exists** (review of E08: `pnpm compose:platform` alone must not record `not_deployed` while Langfuse's data is still there), unless it is set elsewhere. Switching observability off does not delete Langfuse's volumes; the runbook also sets the URL in `.env` (T11 §5m).
- `project.purged` events written before E08 keep `langfuse: manual`; the intents of such projects are still purged in Langfuse by the step (it works per intent).

### 2.8. Settings

`SDLC_WORKER_LANGFUSE_URL` (`off`), `_SECRET_PATH` (`worker/langfuse`), `_PROJECT_ID` (`sdlc-platform`), `_CLICKHOUSE_URL` (`http://clickhouse:8123`), `_BATCH` (50 intents per project and pass), `_RAW_URL` (`http://seaweedfs:8333`), `_RAW_BUCKET` (`langfuse`), `_RAW_MAX_AGE_HOURS` (24, 1–720), `_RAW_BATCH` (2,000). No project configuration and no new mandatory rule.

## 3. Alternatives considered

| Alternative | Why not |
|---|---|
| A Langfuse project per tenant | Needs an organisation key (Enterprise) to make projects and keys; the collector would need one key per tenant and a routing rule; the raw files would still mix tenants inside one project. |
| A ClickHouse TTL on the event tables | One retention for every tenant and project; no archive purge; no holds. |
| Keep it manual | FR-44 asks for the purge; a manual step is forgotten. |
| Select by `tenant:` and `project:` tags | Slugs are labels a person could misread; our run IDs come from our own database. |
| A SeaweedFS lifecycle or TTL rule for the raw files | Would need its own live check on 4.48 and is harder to test; the worker sweep is counted, logged and has a `report` mode. |
| The operator runs `APPLY DELETED MASK` | A manual step is forgotten; the deleted rows would stay on disk. |
| The init key copied into OpenBao for the worker | Two holders of one key; no separate revocation. |

## 4. Consequences and gaps

- An archived project is complete (`project.purged`) only when its Langfuse traces are confirmed deleted; this takes one more pass than the evidence.
- Langfuse holds no client data of a purged intent once the purge is confirmed and compacted: not in the API, not on ClickHouse's disk, not in the raw files.
- **Gaps:**
  - unscoped Langfuse keys (§2.6);
  - `sdlc_purge` could delete every row of the two tables (§2.5);
  - ~~ClickHouse's admin user `langfuse` now has access management~~ closed by ADR-M63 §6 (A10): `langfuse` cannot create users or grants; the loopback-only `sdlc_admin` makes `sdlc_purge`;
  - the compaction owed and the set-aside intents live only in memory (§2.2, §2.5);
  - a confirmation is final: a purge confirmed wrongly can be undone only by the migration owner on the server (the project check of §2.2 is the guard against it);
  - `not_deployed` relies on the URL setting or the ClickHouse volume (§2.7);
  - model calls are found only by their run tag: every LiteLLM call goes with a run key, so every trace has one (ADR-M24 §2.2);
  - the traces are selected under the intent lock: a slow Langfuse delays hold commands on that intent (as the S3 deletes of ADR-M51 §4);
  - a Langfuse upgrade may change the API or the table names (the live test catches it);
  - `worker-langfuse-credentials` checks the SeaweedFS identity by name, like the other `*-credentials` commands.
- One more ClickHouse user and one more SeaweedFS identity to rotate (runbook T11 §5m).

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-10-05 | Claude (task E08) | First version: the spike (AC1), the step of the retention pass, selection by run IDs and the tag check, request then confirm, the raw file sweep, the ClickHouse compaction, the worker's key and credentials, `not_deployed` and `unavailable` |
| 0.2 | 2026-10-05 | Claude (task E08) | After the code review: the key's project checked before any Langfuse step; the tenant guard; no starvation (order, set aside); the request recorded before the delete is sent; `up.sh` keeps the purge on when Langfuse's volume exists; the gaps |
| 0.3 | 2026-10-07 | Claude (issue #177, PR 2), approved by Harry | §2.5: checked again on Langfuse 4.50.0 and ClickHouse 26.3.39.7 |
| 0.4 | 2026-10-09 | Claude (task A10), approved by Harry | §2.3 and the gaps: access management of `langfuse` replaced by the loopback-only `sdlc_admin` (ADR-M63 §6, QUESTIONS #330) |
