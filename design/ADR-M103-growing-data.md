# ADR-M103. Data that only grows: run events, sessions, challenges, partitions

| Item | Value |
|---|---|
| Status | **Accepted** (task O04) |
| Date | 2026-10-31 |
| Decided by | Harry (O04 plan approved with the recommended answers, 2026-10-31; QUESTIONS #646–#648) |
| Related | D-08 task O04; FR-44, NFR-01; QUESTIONS #440; D-05 §6.1, §10, §12 (version 1.66); ADR-M51 (the retention loop); ADR-M97 (client data deletion); ADR-M101 (alerts); rules R030, R075 |

## 1. Context

Some tables only grow. O04 asked three things:

- **`run_events` older than 1 year.** D-05 §10 says they are summarised, then removed. The task allows keeping them instead, with a reason.
- **Ended web sessions and old passkey challenges.** D-05 §6.1 left their removal to "a later retention-loop task with its own grant". Today a trigger refuses every DELETE on both tables, for every role.
- **Monthly partitions of the append-only tables.** O04 asks for a measured decision: when they are needed, and how the hash chain and the triggers stay intact.

Two rules bear on the first question:

- The root `CLAUDE.md` (R030) lists `run_events` as append-only: kept at least 2 years, never edited or deleted.
- ADR-M97 promises a client that a deletion leaves every append-only table intact for at least 2 years.

## 2. Decision

1. **`run_events` are kept** (QUESTIONS #646). They follow every append-only table: at least 2 years, never deleted in v0.x. D-05 §10 changes from "1 year, then summarised" to that rule. The reasons:
   - R030 and the invariant of ADR-M97 would both break.
   - The rows hold codes, IDs and counts only, never client data (R031).
   - They are small (§2.3).
   - A summary would lose what an audit needs: the exact sequence of a run.
2. **Ended sessions and old challenges are removed by the retention loop** (QUESTIONS #647). Migration `0046-housekeeping` makes the removal narrow:
   - **Two definer functions** do the removal. They are `SECURITY DEFINER`, owned by `platform`, with a fixed `search_path`, and EXECUTE is granted to `platform_app` only. Each removes one tenant's rows:
     - `housekeeping_remove_passkey_challenges(tenant, before)`: challenges used, or expired unused, before the cutoff;
     - `housekeeping_remove_web_sessions(tenant, before)`: sessions ended (signed out or expired) before the cutoff that no challenge still needs (`passkey_challenges` references them, so challenges go first).
   - **The cutoffs.** A function refuses a cutoff later than its floor (`SDA27`): 7 days for sessions, 1 hour for challenges. The worker's settings are `SDLC_WORKER_SESSION_KEEP_DAYS` (default 30, at least 7) and `SDLC_WORKER_CHALLENGE_KEEP_HOURS` (default 24, at least 1).
   - **Two locks.** The delete trigger of each table refuses every DELETE (`SDA01`) unless a function opened a transaction-local guard; even then it refuses a row younger than the floor (`SDA27`). `platform_app` still has no DELETE, so setting the guard itself does nothing for it. One trigger function per table, because PL/pgSQL may read every column of a condition before it decides.
   - **The loop.** The retention loop runs `runHousekeepingPass` under the retention lock, after the anchor and the evidence parts. It needs only the database, so it also runs without the S3 identities. `SDLC_WORKER_HOUSEKEEPING_MODE` is `remove` (default), `report` (counts only) or `off`. The rows hold hashes and times only, so removing them loses nothing anyone needs; hence the default.
   - **The audit.** A tenant with removals gets one `housekeeping.removed` (`sessions`, `challenges`: counts; entity = the tenant), in the same transaction as the removal.
   - **Failures.** Housekeeping runs before the evidence pass, so a failing evidence pass (S3 down) never stops it. Its own failure is logged by code and never stops the loop's other parts.
   - **The tenant.** A function trusts the tenant ID it is given: the database does not check that the caller works for that tenant. The repository always passes its own scope's tenant (R026). Even a wrong ID could only remove another tenant's rows that are ended, past the floor and no longer needed; open and recent rows stay protected by the conditions and the trigger.
3. **Partitions: measured, not now** (QUESTIONS #648). Measured on PostgreSQL in a throw-away container, with the indexes:

   | Table | Bytes per row |
   |---|---|
   | `audit_log` | about 700 |
   | `gate_decisions` | about 570 |
   | `cost_records` | about 480 |
   | `run_events` | about 290 |

   An audit chain check (`adlc audit verify`) reads about 115,000 events a second; appending is about 1 ms per event under the tenant's chain lock.

   A busy deployment can be estimated, as a proposal: 50 intents a day, about 40 audit events, 50 run events, 100 cost records and 10 gate decisions per intent. That is about 1–2 million rows a year per table, under 1 GiB a year. 20 GiB is 30–70 million rows, many years away; a chain check would then take about 5 minutes. Partitions would add risk today (the triggers, the grants, the unique keys must include the partition key) and gain nothing.
   - **`pnpm doctor` gets the check `db.table_size`.** It reads the size of every append-only table with a read-only `SELECT` (allowlisted, R080). It warns when one reaches `SDLC_DB_TABLE_WARN_GB` (default 20). `pnpm alerts` (ADR-M101) sends that warning, which gives years of notice.
4. **How partitions will be added**, when the warning comes. This is a design for that later task, not built now:
   - Range partitions by month on `created_at` (`occurred_at` for `cost_records`), on a new parent table; the old table becomes the first partition (`ATTACH`), so no row moves.
   - Primary and unique keys include the partition key. For `audit_log` that is `(tenant_id, seq, created_at)`, and the per-tenant chain stays unchanged. The hash covers the canonical event, never the physical row, and `seq` stays the order (ADR-M09).
   - Row triggers (`forbid_mutation`, the chain link check) and grants are declared on the parent; PostgreSQL applies them to every partition, and a test checks each partition.
   - Old partitions are **never dropped** while the 2-year rule holds. Detaching one to cheaper storage needs its own decision.

## 3. Consequences

- **Migration `0046-housekeeping`.** It holds the first `SECURITY DEFINER` functions of the platform, and their privileges are tested. The lock file gets its line (R075).
- **New settings**, all with defaults; `pnpm compose:env --add-missing` appends them on an upgrade:
  - worker: `SDLC_WORKER_HOUSEKEEPING_MODE`, `SDLC_WORKER_SESSION_KEEP_DAYS`, `SDLC_WORKER_CHALLENGE_KEEP_HOURS`;
  - env file: `SDLC_DB_TABLE_WARN_GB`.
- On the first pass after the upgrade, every tenant with old sessions gets one `housekeeping.removed`.
- **Tests:**
  - `platform/tests/integration/db/housekeeping.test.ts` (`pnpm test:db`): the cutoffs and the floors; challenges before their session; open and recent rows kept; one tenant at a time; the audit event and the chain; no DELETE for `platform_app` and none for the owner outside the functions; the functions' privileges.
  - `platform/tests/worker/retention-loop.test.ts` and `settings.test.ts`: the loop step and the worker settings.
  - `platform/tests/doctor/checks.test.ts` and `host-readonly.test.ts`: `db.table_size` and the read-only query.
  - `platform/tests/audit/actions.test.ts`: the new audit action.

## 4. Rejected

- **Summarising `run_events` after 1 year, or after 2 years, then deleting them.** It breaks R030 and the invariant of ADR-M97 (§2.1).
- **A DELETE grant for `platform_app`** on the session tables. Any bug or injected query could then delete open sessions; the functions allow only old, ended rows of one tenant.
- **Partitioning now.** See §2.3.

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 1.0 | 2026-10-31 | Claude Code (task O04), approved by Harry | `run_events` kept; sessions and challenges removed by definer functions in the retention loop; the measured growth, `db.table_size`, and the later design of partitions (QUESTIONS #646–#648) |
