# ADR-M51. Evidence retention: object lock, the purge, holds, archived projects

| Item | Value |
|---|---|
| Status | **Proposed** (task E05 PR 1, merged; PR 2, for review) |
| Date | 2026-10-04 |
| Decided by | Harry (plan approved 2026-10-04, with answers to QUESTIONS #235–#239) |
| Related | D-08 task E05 (AC1–AC4); D-02 FR-44, §10; D-03 §7.5, §8.2, §10; D-05 §6.6, §7.4, §10, §10.1; ADR-M17 (Compose, SeaweedFS); ADR-M24 §2.5 and ADR-M28 (worker loops); ADR-M33 §2.9 (gaps 1–4); ADR-M35 (Langfuse holds client data); ADR-M37 (archive); ADR-M48 §2.1, §2.7; ADR-M49 §2.7; handbook Ch.15, Ch.19 §19.8d, T11 §5j; QUESTIONS #235–#239 |

## 1. Context

D-02 FR-44 asks for three things:

- the audit log and gate decisions are kept at least 2 years;
- evidence files are kept 6 months by default;
- archiving a project purges its client data and evidence files unless on hold, keeping hashes.

D-05 §10.1 describes the purge: delete the files in SeaweedFS, keep the rows and hashes, set `purged_at`, write `evidence.purged`. D-05 §7.4 adds a daily anchor of each tenant's audit hash (AC4, PR 2 of this task, §2.9).

What existed before E05:

- Three identities write the versioned bucket `evidence`, each with `If-None-Match: *` (never overwritten):
  - `runner-evidence`: proposals, diffs;
  - `api-evidence`: packs (E02);
  - `worker-evidence`: packs at G8 (E03).
- SeaweedFS has no write-only action, so each writer can also delete under its prefixes, a specific version included (ADR-M33 §2.9 gap 1).
- Object lock was left to E05 (Harry, review of PR #112).
- `evidence_items` and `evidence_packs` hold the URIs, hashes and sizes. `purged_at` had no UPDATE grant. `evidence_packs.retention_hold` existed, but no hold could reach an intent without a pack.
- `archiveProject` (B13) archived a project, open intents too, and purged nothing.

## 2. Decision

### 2.1. Object lock: GOVERNANCE, 180 days, on the existing bucket

**Checked live on the pinned SeaweedFS 4.48** (throw-away containers, 2026-10-04):

| Check | Result |
|---|---|
| Turn on object lock for an **existing** versioned bucket | Works (`s3.bucket.lock -enable`, or `PutObjectLockConfiguration`): the bucket keeps its name, so dev, CI and the server need no new bucket and no copy |
| Bucket default retention | Applies to every new version, also from an identity with only `Write:<prefix>/*` that sends no lock header. The writers need no code change |
| Versions written before the lock | Have no retention: the purge deletes them normally |
| COMPLIANCE | Nobody can delete or shorten through S3, the admin included; survives a restart; versioning can no longer be suspended |
| GOVERNANCE + `BypassGovernanceRetention:<prefix>/*` | Writers are refused, even with the bypass header; only the identity with the action (and the admin) deletes early |
| Legal hold (`PutObjectLegalHold`) | Refuses deletion even after the retention ends and even with the bypass |
| `@aws-sdk/client-s3` 3.1141.0 | `DeleteObject` with `VersionId` and bypass, `PutObjectLegalHold`, `Get`/`PutObjectRetention`, `ListObjectVersions` all work against it |
| The filer API (`seaweedfs:8888`) | **Skips the lock**: see gap 5 (§4) |

**Decision (Harry, plan approval):**

- The bucket `evidence` gets object lock, mode **GOVERNANCE**, default retention **180 days**. `seaweedfs-init` sets it through `SEAWEEDFS_LOCKED_BUCKETS=evidence:GOVERNANCE:180`:
  - `s3.bucket.lock -enable` turns the lock on;
  - the default retention goes through the S3 API, with the admin keys on curl's stdin, never as arguments;
  - the result is checked, and a re-run changes nothing.
- **Effect on the three writers:** from the lock on, none of them can delete a version during its first 180 days. A plain delete still only leaves a delete marker. This closes ADR-M33 §2.9 gap 1 for that period.
- **Why GOVERNANCE, not COMPLIANCE:** the purge of an archived project (FR-44, §2.6) must delete young evidence. With COMPLIANCE that would wait up to 180 days. Only the purge identity holds the bypass, and only the archive purge and the orphan sweep send it.
- **Holds use a legal hold** (§2.5), which refuses even the bypass.
- **Projects that keep evidence longer than 180 days:** the loop moves the files' lock forward before it ends (`lock_extended_until`, never back). The writers then stay locked out for the whole retention.
- **The days equal the floor of rule M31 and the code minimum (§2.4).** Lowering them needs a handbook change.

### 2.2. When evidence is purged

- **One clock per intent.** An intent's rows (its evidence items and every pack version) are purged when `now ≥ max(intent end, row created) + evidence_retention_days`.
  - The intent end is `intents.updated_at` of a finished intent (`done`, `rejected`, `cancelled`, `blocked`): the time of its final move. For `done` that is the G8 move, which seals the pack in the same transaction.
  - A finished intent never moves again. If its `updated_at` ever moved, the purge would only come later.
- **Open intents are never purged**, whatever their age.
- **Sealed and unsealed pack versions are purged together**, with the intent's evidence (ADR-M48 §2.7).
- **Effective retention:** project config `retention.evidence_retention_days`, read at purge time. There is no tenant-level override in the MVP (`tenants` has no such column; D-05 §10.1 now says MVP+1).
- **A configuration that cannot be loaded** (drift, a hash mismatch) purges nothing for retention and moves no lock (fail closed, `retention.config_unavailable`).

### 2.3. Who deletes: the identity `worker-purge`

- **Created by** `pnpm openbao:bootstrap worker-purge-credentials` (runbook T11 §5j). Stored at `kv/worker/purge`; the `worker` AppRole already reads `kv/data/worker/*`.
- **Rights:**
  - `List:evidence` (versions, the orphan sweep);
  - on `evidence/proposals/*`, `evidence/diffs/*` and `evidence/packs/*`: `Write` (which includes delete), `BypassGovernanceRetention`, `PutObjectLegalHold`, `PutObjectRetention`, `GetObjectRetention`.
  - **No `Read`**: it never sees content. Checked live.
- **The bootstrap helper is now generic** (`s3_credentials`): the api's and the worker's evidence identities use it too, unchanged.
- **Adapter:** `S3RetentionStore` (`@sdlc/adapter-evidence-s3`) implements `EvidenceRetentionStore` (`@sdlc/contracts`):
  - `deleteAllVersions` lists every version and delete marker of exactly the key, deletes each, and checks that none is left;
  - `setLegalHold`, `extendLock` (never shortens), `listKeys`;
  - a URI outside the bucket or the three prefixes is refused.
- **Settings:**
  - `SDLC_WORKER_RETENTION_URL` (`off` = no loop), `_BUCKET`, `_SECRET_PATH`;
  - `_MODE` (`report` | `purge`, default `report`);
  - `_INTERVAL_MINUTES` (60), `_BATCH` (200);
  - `_GUARD_PERCENT` (20), `_GUARD_FLOOR` (20);
  - `_ARCHIVE_GRACE_DAYS` (7), `_ORPHAN_GRACE_HOURS` (24).
- **No credential:** a warning at start (`worker.retention_missing`) and no loop.

### 2.4. Safety: nothing is purged early

Deleting cannot be undone, so several independent checks must all agree:

1. **Rule M31** (QUESTIONS #236): 180 ≤ `evidence_retention_days` ≤ 3650.
2. **The code minimum** `MIN_EVIDENCE_AGE_DAYS = 180` (core `retention/rules.ts`): nothing younger than 180 days, from its creation and from its intent's end, is purged for retention, whatever the configuration says. The database selection uses the same floor.
3. **The bucket's lock** (§2.1): a retention purge never sends the bypass, so a bug that selects a young row still meets the lock.
4. **`report` by default:** the loop counts and logs what it would purge. `purge` must be set (`.env`).
5. **A third decision under the intent lock.** Each row is decided again right before its delete, inside a transaction holding the intent lock and the row (`FOR UPDATE`), with the time of that moment. A hold set meanwhile wins (holds take the same intent lock). Then the store deletes every version, and `purged_at` and `evidence.purged` are written in the same transaction.
6. **The guard.** One pass purges for retention at most `GUARD_PERCENT` % of a tenant's stored rows, or `GUARD_FLOOR` rows when that is larger. Beyond it the tenant's retention purges stop (`retention.guard_tripped`) until an operator raises the setting.
   - The guard counts **every** row due for retention (a separate count without the batch limit), so a bug that makes every row due trips it even when the batch is small (code review of PR 1).
   - Archive purges are not counted: their grace period and the scheduling event (§2.6) protect them.
   - The re-check under the intent lock (item 5) reads the project's status, its archive events and its configuration again; it never trusts the selection's snapshot.
7. **URIs must belong.** Every URI must be in the bucket, under one of the three prefixes and the row's own tenant folder; otherwise the row is refused (`retention.uri_unexpected`).
8. **One process at a time:** a session advisory lock (`SystemScope.withRetentionLock`), as C12.

Tests use a fake clock: day 179 is kept and day 181 purged. They also cover a configuration of 1 day (the code minimum holds), holds, open intents, a configuration that cannot be loaded, other tenants, and the guard.

### 2.5. Holds (QUESTIONS #235)

- **A hold is per intent**, in the new table `evidence_holds` (migration 0023):
  - columns: who, when, an optional `https://` link to the reason (never text);
  - `released_at`/`released_by` set once;
  - `applied_at` (only forward) and `release_applied_at` (once) record what the loop did in the store;
  - at most one active hold per intent;
  - no delete (trigger `SDA16`).
- **`evidence_packs.retention_hold` is not used** and gets no UPDATE grant (D-05 note).
- **Who:** tenant admins, or a role in new config `access.evidence_hold_roles` (default `[governance, admin]`). **Mandatory rule M32:** never `viewer`. No role on the project → `intent_not_found` (404); another role → 403.
- **Commands:**
  - API `GET`/`PUT`/`DELETE /v1/intents/:intent/evidence-hold`;
  - CLI `sdlc admin evidence hold <INT> [--ref <https link>]`, `release <INT>`, `show <INT>`;
  - refusals `evidence_hold_exists` (409), `evidence_hold_not_found` (404).
- **Audit:** `evidence.hold_set`, `evidence.hold_released` (the hold ID).
- **In the store:** every pass first takes the legal hold off the files of released holds (unless a new hold is active), then sets it on the files of active holds. This runs in `report` mode too: it only protects.

### 2.6. Archived projects (AC3, QUESTIONS #237, #238)

- **`archiveProject` refuses a project with open intents** (`project_has_open_intents`, 409).
- **The archive grace period** (Harry, plan approval): an archived project's evidence is purged only `SDLC_WORKER_RETENTION_ARCHIVE_GRACE_DAYS` (default 7) after its latest `project.archived` audit event. A mistaken archive can be noticed first.
  - Without that event nothing is purged as an archive.
  - Tests: 6 days kept, 8 days purged.
- **The scheduling event** (code review of PR 1): the first pass in `purge` mode that finds an archived project writes `project.purge_scheduled` (once per archive, with the grace days) and logs `retention.archive_purge_scheduled`. The grace runs from the **later** of the archive and that event.
  - So a project archived before E05, or while the loop ran in `report` mode, still gets the whole grace period from the moment the purge is turned on, and the operator sees it coming.
  - `report` mode never schedules; the report shows such a project as not due.
- **What is purged:** every finished, not held intent's evidence of the project, with the lock bypass (`cause: archive`). Held intents stay and are counted.
- **`project.purged`:** written once, when nothing purgeable is left, with the counts (`intents`, `purged`, `held`) and `langfuse: manual`.
- **"Stored client material" in the platform = the evidence files:**
  - proposals and diffs (client code);
  - pack files (approver names).
  - The database holds codes, IDs and hashes only.
  - LiteLLM's spend logs do not keep prompts (`store_prompts_in_spend_logs` is not set).
  - Temporal holds IDs only.
- **Langfuse** holds prompts and responses (ADR-M35). It is **not** purged in E05 (QUESTIONS #238): the runbook (T11 §5j) gives the manual steps, and a follow-up task (E08) will build it.
- **Open item: there is no un-archive in the MVP.** A mistaken archive is undone only within the grace period, by a database change on the server. An `unarchive` command is not built.

### 2.7. The orphan sweep (ADR-M48 §2.7)

- **What it looks for:** pack files under `packs/<tenant>/<intent>/<pack id>/` whose pack ID has no row, older than `ORPHAN_GRACE_HOURS` (a build that failed after its upload).
- **What it does:** deletes every version, with the bypass (the files are younger than the lock), and audits `evidence.orphan_swept` (pack ID, counts) in the tenant named by the path, when that tenant and intent exist.
- **How far:** one page per pass, continued on the next pass. Only `packs/`: proposals and diffs without a row are never deleted.
- **Safety** (code review of PR 1):
  - a pack ID is deleted only when it was found without a row on an **earlier visit** too (the loop keeps the suspects across passes), so one wrong answer of the row query never deletes pack files;
  - at most 20 pack versions per pass;
  - the grace is at least 24 hours (setting minimum).

### 2.8. The loop

- **`RetentionLoop`** (worker): a plain loop like the escalation clocks (ADR-M28) and the spend sync (C12), not a Temporal schedule. It carries no workflow data, a fake clock tests it, and the advisory lock gives one process at a time.
- **Before the retention steps** (PR 2): the daily audit anchor of every tenant (`runAnchorPass`, §2.9).
- **Each pass** (`runRetentionPass`, core), every tenant:
  1. holds;
  2. lock moves;
  3. the purge (guard first; counts only in `report`);
  4. archive completion.
  Then the orphan sweep.
- **Failures:** a failed row, project or tenant is logged by its code and counted; the next pass retries. The loop never throws.
- **Operator report:** `pnpm sdlc ops retention report --tenant <slug> [--json]`. Counts only, from the database: per project, stored, due now, held, open, purged.

### 2.9. The daily audit anchor (PR 2, AC4; D-05 §7.4)

`sdlc audit verify` finds a changed or missing row. It cannot find a whole chain that someone with database access rewrote with new, linked hashes. D-05 §7.4 therefore writes each tenant's latest audit hash outside the database every day; an older anchor then no longer matches.

**Checked live on the pinned SeaweedFS 4.48** (throw-away containers, 2026-10-04), bucket versioned, object lock COMPLIANCE 731 days, an identity with `Write`, `Read`, `List` on that bucket only:

| Check | Result |
|---|---|
| A second write of the same key with `If-None-Match: *` | 412 |
| The anchor identity deletes a version | 403 |
| The admin deletes a version, with or without the bypass header | 403 |
| The admin shortens a version's lock, or changes it to GOVERNANCE | 403 |
| The admin suspends versioning | 409 |
| A restart | versions and locks kept |
| The anchor identity reads or writes `evidence` | 403 |
| ⚠ The admin changes the bucket's **default** to GOVERNANCE 1 day | Allowed; only new versions are affected |
| ⚠ The anchor identity sends a plain DELETE (no version) | Allowed: a delete marker. After it, `If-None-Match` accepts a **second version** of the key. The original stays readable and locked |
| `GetObjectRetention` | Needs its own action |

**Decision (Harry, plan approval, 2026-10-04):**

- **The bucket** `audit-anchors`, apart from `evidence` (so a `List` there sees no evidence): versioned, object lock **COMPLIANCE, 731 days** (more than the 2 years of FR-44). `seaweedfs-init` creates and locks it with the existing settings (`SEAWEEDFS_BUCKETS`, `SEAWEEDFS_VERSIONED_BUCKETS`, `SEAWEEDFS_LOCKED_BUCKETS=… audit-anchors:COMPLIANCE:731`); `create-buckets.sh` needs no change.
- **The identity** `worker-anchor` (`kv/worker/anchor`, `pnpm openbao:bootstrap worker-anchor-credentials`, the generic `s3_credentials` helper, runbook T11 §5k): `Write`, `Read`, `List`, `GetObjectRetention` on `audit-anchors` only. Under COMPLIANCE its `Write` can delete no version.
- **The anchor:** `<tenant ID>/<YYYY-MM-DD>.json`, the RFC 8785 canonical JSON of `{anchored_at, hash, hash_version, seq, tenant_id}` of the tenant's last audit row. The date is the UTC date of `anchored_at`. Written with `If-None-Match: *`.
- **Interfaces:** `AuditAnchorStore` (`@sdlc/contracts`), `S3AuditAnchorStore` (`@sdlc/adapter-evidence-s3`, keys `<uuid>/<YYYY-MM-DD>.json` only), `runAnchorPass` and the pure rules in core `audit/anchor.ts`, `AuditLogRepository.latest` and `hashesAt`.
- **When:** in the retention loop (§2.8), **first**, under the same advisory lock, at its interval. Once per tenant and UTC day per process (the loop remembers the day); after a restart one write per tenant answers 412, which counts as "already anchored today". The loop now runs when either identity exists (`worker-purge`, `worker-anchor`); each part runs only with its own, and a failed anchor pass never stops the retention steps. Setting `SDLC_WORKER_ANCHOR_URL` (`off`), `_BUCKET`, `_SECRET_PATH`.
- **No backfill:** a day the worker was down gets no anchor. An anchor's date is the day it was written; a back-dated one would be false.
- **Written even without new rows:** it shows that the chain did not shrink.
- **A tenant without audit rows** gets no anchor (`worker.audit_anchor_empty`). Every tenant has `tenant.created` from its bootstrap, so this should not happen; a new tenant is anchored at the next pass.
- **Check first, then write.** Each tenant, once a day: every version of every anchor under its folder is read and compared with the row at its `seq`. The reasons:
  - `hash_mismatch`: the row has another hash (the chain was rewritten);
  - `seq_missing`: no row at that `seq` (the chain shrank);
  - `anchor_invalid`: not a well-formed anchor of this tenant and date (strict parse: exactly the five fields, the folder's tenant, the key's date, canonical bytes);
  - `anchor_versions`: a key with a delete marker or more than one version (the ⚠ row above). Every version is still compared, so the original is checked too.
- **On a mismatch:** one `worker.audit_anchor_mismatch` log line (error) per mismatch (tenant, date, `seq`, reason) and one `audit.anchor_mismatch` audit event per check run in that tenant's chain (counts, the first reason and `seq`). **Never a hash** in either. Runbook T11 §5k gives the operator's steps.
- **The new anchor's lock is checked** (the other ⚠ row): COMPLIANCE until at least `anchored_at` + 730 days, else `worker.audit_anchor_unlocked` (error).
- **The operator log:** `worker.audit_anchored` carries `seq`, `hash` and `hash_version` (D-05 §7.4 "the operations log"; an audit hash is neither personal data nor a secret; the logger keeps a field named `hash`, tested).
- **`sdlc audit verify` stays database-only.** An operator command that reads the anchors with its own S3 credential may come later.
- **Cost:** every anchor of every tenant once a day: about 731 small reads (≤ 1 KiB) per tenant and day at most, plus one database query per 1000 anchors. Accepted for the MVP (Harry, plan approval).
- **Later optimisation (not built):** anchors never change, so the check could list the versions daily (that still finds delete markers and new versions), read only versions it has not seen before, and keep their parsed content in memory.

**Gaps of PR 2:**

- **Gap 5 applies to anchors too:** the filer API (`seaweedfs:8888`) can delete an anchor whatever its lock, until task A12.
- **After 731 days** an anchor's lock ends and the anchor identity could delete it. That is past the 2 years of FR-44; accepted.
- **The admin can lower the bucket's default lock** for new anchors. The per-anchor check finds it the same day; anchors already written keep their lock.
- **COMPLIANCE cannot be undone.** On the server, anchors stay 731 days. On development volumes too; removing the volume removes them.

## 3. Alternatives considered

- **A per-object lock at write time, equal to the project's retention.** Rejected: the three writers would need the project's retention and `PutObjectRetention` on their prefixes, and a hold would still need the legal hold. The bucket default locks every writer with no change, and the loop extends longer projects.
- **No lock in the MVP (versioning and hashes only).** Rejected: the writers can delete versions (gap 1), and the purge would be the only line.
- **COMPLIANCE.** Rejected for `evidence`: the archive purge needs to delete young evidence (FR-44). Used for the audit anchors (§2.9).
- **Anchors in the bucket `evidence`** (PR 2). Rejected: its GOVERNANCE lock can be bypassed by `worker-purge`, and a `List` there would show evidence keys to the anchor identity.
- **Checking only the last N days of anchors** (PR 2). Rejected for the MVP: a whole-chain rewrite is shown only by an anchor older than the rewrite, which may be months old.
- **A new bucket.** Not needed: the live check showed the lock can be turned on for the existing versioned bucket.
- **A Temporal schedule.** Rejected as in C12 (QUESTIONS #225).

## 4. Consequences and gaps

- **Gap 5 (QUESTIONS #239, new): the filer API skips the lock.** Checked live on 4.48:
  - a plain HTTP `DELETE` on `seaweedfs:8888`, and `weed shell fs.rm`, delete a version that has a COMPLIANCE lock and a legal hold;
  - an HTTP `GET` from another container reads any file.
  - The filer has no authentication, and every container on the network `sdlc` reaches it. So any process there (api, worker, runner, LiteLLM, Langfuse, Temporal…) can read or delete all evidence, bypassing the S3 identities and the lock. Sandboxes are not on that network.
  - Not fixed in E05: task A12, before the trial M-E (for example filer JWT signing in `security.toml`, or a filer bound to its own container, with a live test).
- **Gap 3 stays:** the `.env` admin identity can bypass GOVERNANCE.
- **Gap 4 stays:** the S3 secrets sit in the filer store on disk.
- **The worker holds one more credential** (`worker-purge`). It can delete evidence after its lock, and bypass the lock under the three prefixes. It cannot read.
- **The lock itself:**
  - Dev and CI volumes keep locked test objects up to 180 days. Throw-away Compose projects remove their volume.
  - A version written by mistake cannot be removed through S3 for 180 days, except by the purge identity's bypass.
- **Run in `report` first** on a server with old evidence: when switched to `purge`, a backlog trips the guard until the operator raises it.
- **Known limits** (code review of PR 1, accepted for the MVP):
  - a pack has two files; if the second is refused after the first was deleted, the row stays unpurged and the next pass tries again (both files are written, locked and held together, so this needs a fault between two calls);
  - the S3 deletes run inside the database transaction that holds the intent lock: a slow store delays hold commands on that intent;
  - the session advisory lock is lost if its connection drops mid-pass (as C12); the per-row intent lock still serialises deletes;
  - any role in `access.evidence_hold_roles` may release a hold someone else set; the audit log records who.
- **Langfuse is not purged** (QUESTIONS #238, E08).
- **Open items for M-F** (Harry, review of PR 1):
  - an un-archive command (today a mistaken archive is undone only within the grace period, by a database change on the server);
  - whether a hold must be released by a different person than the one who set it.

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-10-04 | Claude (task E05, PR 1) | First version: lock, purge, holds, archive, guard, report mode (AC1–AC3). PR 2 adds the daily audit anchor (AC4) |
| 0.2 | 2026-10-04 | Claude (task E05, PR 1) | After the code review: the archive purge is scheduled first (`project.purge_scheduled`), the guard counts every due row, the re-check reads project and configuration again, the orphan sweep needs two sightings and a cap; known limits |
| 0.3 | 2026-10-04 | Claude (task E05, PR 1) | §4: open items for M-F (an un-archive command; who may release a hold), after Harry's review |
| 0.4 | 2026-10-04 | Claude (task E05, PR 2) | §2.9: the daily audit anchor (AC4): the live check of COMPLIANCE on SeaweedFS 4.48, the bucket `audit-anchors`, the identity `worker-anchor`, check then write once per tenant and UTC day, the mismatch reasons, the lock check, the later optimisation; §3: two alternatives |
