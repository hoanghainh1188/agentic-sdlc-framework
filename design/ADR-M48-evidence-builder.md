# ADR-M48. Evidence Builder and the readable Evidence Pack

| Item | Value |
|---|---|
| Status | **Proposed** (task E02, for review) |
| Date | 2026-10-04 |
| Decided by | Harry (plan approved 2026-10-04, with answers to QUESTIONS #215–#219) |
| Related | D-08 task E02 (AC1–AC4), E03, E05; D-02 FR-40, FR-42, FR-43, FR-44; D-03 §5.2, §7.5, §8.2, §10; D-05 §6.6, §10; ADR-M32 (project AI record, disclosure format); ADR-M33 §2.9 (evidence store, gaps 1–4); ADR-M45 (cost sums); ADR-M26 §2.5; handbook Ch.2 Rule 6, Ch.15 §15.10.2, T11 §5h; QUESTIONS #215–#219 |

## 1. Context

D-02 FR-40 asks for one Evidence Pack per intent: spec and hash, plan, diff, CI, tests and scans, the gate decisions, tokens and cost. FR-42 asks for a readable Markdown export that can be sent to a client "after redaction". FR-43 asks for the client AI disclosure note in the pack; G8 (E03) fails without it.

What existed before E02:

- `EvidenceStore` (`@sdlc/contracts`) and `S3EvidenceStore` (`@sdlc/adapter-evidence-s3`) on SeaweedFS. Every put sends `If-None-Match: *`, so stored evidence is never overwritten.
- `evidence_items`: one row per stored file (L1 proposals, run diffs) with its SHA-256 and size. Written once.
- The runner's identity `runner-evidence`. It may write proposals and diffs, and read diffs. SeaweedFS has no write-only action, so it may also delete under those prefixes (ADR-M33 §2.9 gap 1). Versioning keeps the content.
- The data the pack lists: spec and plan versions (hashes, never text), runs and their coded run events, gate decisions, escalations, cost records, the project AI record (`disclosure_format`, `record_ref`).
- `evidence_packs` existed in the D-05 design only (1–1 with the intent), not as a table.

## 2. Decision

### 2.1. One pack per build, never changed (QUESTIONS #215)

- A person builds a pack on demand through the API or the CLI. E03 calls the same core function (`buildEvidencePack`, actor `system`) at G8 and seals one version.
- **Every build is a new version.** It gets a pack ID and two new files:
  - `s3://evidence/packs/<tenant>/<intent>/<pack id>/manifest.json`
  - `s3://evidence/packs/<tenant>/<intent>/<pack id>/pack.md`
- Then one row in `evidence_packs` takes the next version: unique (tenant, intent, version). A concurrent build retries with the next version, at most 3 times.
- **Same content, same version.** `content_sha256` is the SHA-256 of the RFC 8785 canonical manifest content, without the build's own fields (pack ID, version, time, builder). When it equals the latest version's, the build returns that version (`created: false`, HTTP 200) and stores nothing. A purged latest version (E05) is never handed out again: the same content then gets a new version.
- **Sealing.** At most one version per intent is sealed (partial unique index). After that, no new build (`evidence_pack_sealed`, 409).
- **Meaning change (D-05 1.30).** `evidence_packs` holds versions, no longer one row per intent. The table is migration `0021-evidence-packs`.
  - Columns: ID, intent, version, content hash, both files' URI, SHA-256 and size, locale, disclosure format, item count, builder (null for the platform), `sealed_at`, `retention_hold`, `purged_at`.
  - Trigger `SDA14`: every column is fixed except `sealed_at` and `purged_at` (each set once) and `retention_hold`. No delete.
  - Grants: `SELECT, INSERT` now. E03 adds UPDATE on `sealed_at`; E05 adds UPDATE on `retention_hold` and `purged_at`.

### 2.2. Storage identity: `api-evidence`

- **Who builds:** the api process. The core service `evidence/` uses the `EvidenceStore` interface only, so core never imports the adapter. The CLI goes through the API. The worker and the runner are unchanged.
- **New SeaweedFS identity `api-evidence`:** `Read:evidence/proposals/*`, `Read:evidence/diffs/*`, `Read:evidence/packs/*`, `Write:evidence/packs/*`. Nothing else: no list, no other prefix. The live test (`pnpm test:openbao`) checks each of these.
- **Credential:** stored at `kv/api/evidence` by `pnpm openbao:bootstrap api-evidence-credentials` (runbook T11 §5h). The `api` AppRole already reads `kv/data/api/*`, so no policy changes.
  - The keys are made inside the openbao container and reach `weed shell` on stdin only. Its output is discarded.
  - The old identity is deleted first, so a rotation disables the old key.
- **Settings:**
  - `SDLC_API_EVIDENCE_URL` (default `http://seaweedfs:8333`; `off` turns packs off)
  - `SDLC_API_EVIDENCE_BUCKET` (`evidence`)
  - `SDLC_API_EVIDENCE_SECRET_PATH` (`api/evidence`)
  - `SDLC_API_EVIDENCE_MAX_ITEM_MB` (default 256)
- **No credential** (or dev mode without OpenBao): a warning at start. The build and file endpoints check access first, then answer 503 `evidence_unavailable`.
- **A deliberate widening.** With `api-evidence`, the api process can now read L1 proposals and run diffs: client code. Limits:
  - read only, those two prefixes only;
  - capped per item (`SDLC_API_EVIDENCE_MAX_ITEM_MB`, checked from the row and from `Content-Length` before the body is read);
  - one item at a time;
  - the bytes are hashed and dropped: never logged, never kept, never put in the pack.
- **Same gap as the runner's identity:** write includes delete under `packs/`. Mitigations: `If-None-Match: *`, versioning on the bucket, the SHA-256 of both files in `evidence_packs`, re-checked whenever a file is read.
- **Open item for E03, not decided here:** how the worker builds the pack at G8. Options are its own SeaweedFS identity, or another way (for example the api builds on a signal).

### 2.3. The hash re-check (ADR-M33 §2.9 gap 2)

- Every `evidence_items` row of the intent that is not purged is read back. Its SHA-256 and size must match the row.
  - `hash_mismatch` or `size_mismatch` → `evidence_hash_mismatch`
  - a missing object → `evidence_missing`
  - larger than the per-item cap → `evidence_too_large`
- **Fail closed.** Any failure stops the build before anything is stored. Each mismatch or missing object appends one audit event `evidence.check_failed` (item ID, kind, reason): a possible tampering signal. An oversized row is a setting, not tampering, and is not audited. A failure whose reason equals the item's latest recorded failure adds no new row, so repeated builds cannot flood the audit log (kept at least 2 years).
- Purged items (E05) are listed with their hash and `check: purged`, and are not read.
- Reading a pack file back (`GET …/:version/manifest|markdown`) re-checks that file's hash and size. A failure is audited as `evidence.pack_check_failed` and refused.

### 2.4. What the pack holds (QUESTIONS #219, #216)

**The manifest** (JSON, RFC 8785 canonical, `schema_version: 1`) holds only codes, IDs, hashes, versions, counts, times and references:

- the intent (code, risk, data class, autonomy, status, gate, repository, issue and pull request numbers);
- the AI record's version and hash;
- each spec version (path, commit, SHA-256);
- each plan version (file path, commit, SHA-256, number of path patterns, tools, change flags);
- each run (status and stop reason, agent and version, model when known, base and pushed commits, the latest `changes_checked`, `branch_pushed`, `ci_checked`, `g7_checked`, `pr_merged`, `loop_detected`, `kill_requested` payloads, which are coded already, D-05 §6.4);
- each evidence item (kind, URI, SHA-256, size, check result);
- every gate decision with its oversight mode, approver role, decider ID, reason code and `reason_ref`, input hash, waiting time;
- the escalations (codes and times);
- the cost sums (E04's sums, money as decimal strings);
- the disclosure facts (§2.5).

**Never in the pack:** a diff or proposal (the change is in the pull request, and the bytes stay in SeaweedFS), the spec or plan text, a comment or review text, the intent's title or description, a secret.

**The Markdown** (`pack.md`):

- the same data as tables, every label from the message catalog (`evidence.md.*`, English by default, NFR-08);
- the approvers' **display names**, read at build time, next to their role in the gate decision table (QUESTIONS #216); IDs only in the manifest;
- every value escaped: control, bidirectional and zero-width characters are removed, and Markdown syntax is escaped. A name cannot add a link, an image, HTML or a table cell.

**Redaction (FR-42)** is by construction: the pack holds nothing the platform does not already keep as codes. The only personal data is the approvers' names.

**Personal data and retention.** Unlike the audit log, the pack holds personal data (approver names). It is a file in SeaweedFS that E05 purges with the evidence files after `evidence_retention_days` (default 180, D-05 §10.1). The audit events of a build hold hashes and the version only.

### 2.5. The client AI disclosure note (QUESTIONS #217, FR-43)

- **The facts** come from the data: the agents and versions that ran, their models when known, the number of runs that started, the G7 approvals of people that no `void` cancelled, the latest CI result.
- **The text** comes from the catalog per the project AI record's `disclosure_format` (ADR-M32):
  - `standard_note`: our standard note (`evidence.disclosure.standard_note`) with the facts;
  - `client_format`: the platform cannot write the client's own format. The note gives the same facts and a line that the client's format applies: the PM/BrSE writes it from the human AI record (`record_ref`, a link). The manifest marks `client_text_required: true`.
- **E03 decides** whether G8 needs a person to confirm that client note.
- **No AI record:** `ai_record_missing` (409). G1 normally stops this earlier (FR-19).

### 2.6. Who, endpoints, CLI (QUESTIONS #218)

- **Access:**
  - new config `access.evidence_build_roles`, default `[person_a, person_b, pm_brse, governance, admin]`;
  - new config `access.evidence_read_roles`, default the same plus `second_approver`;
  - **mandatory rule M30:** `viewer` is in neither list. A pack is client-facing evidence and names the approvers;
  - tenant admins always may; no role on the project → 404, another role → 403 (as E04, E06);
  - the B13 AC8 re-hash test covers the new defaults.
- **API:**
  - `POST /v1/intents/:intent/evidence-packs`: 201 a new version, 200 the same content;
  - `GET /v1/intents/:intent/evidence-packs`: all versions;
  - `GET …/:version`: one version;
  - `GET …/:version/manifest|markdown`: the file's text with its hash; the hash is re-checked by the server and again by the CLI.
- **Errors:** `ai_record_missing`, `evidence_pack_sealed`, `evidence_pack_not_found`, `evidence_pack_purged` (410), `evidence_hash_mismatch`, `evidence_missing`, `evidence_too_large`, `evidence_unavailable` (503).
- **CLI:** `sdlc evidence build|list|show|export <INT>`. `export` prints the Markdown, or the manifest with `--manifest`. `--output <file>` writes a new file, mode 600, never overwritten.
- **Audit:** `evidence.pack_built` (version, the three hashes), `evidence.check_failed`, `evidence.pack_check_failed`.

### 2.7. Object lock (open item for E05)

- **E02 does now:** versioning on the bucket `evidence` (already on), never overwrite, hashes in the database, re-checked on every read. **No object lock yet.**
- **Open for E05, unchanged:** a lock per object at write time vs per-project retention and `retention_hold` (ADR-M33 §2.9 gap 1, D-08 E05 note). E05 decides it before the purge deletes anything. The files of a build that failed after its upload (no row) are left unreferenced; E05's purge can sweep them.

## 3. Alternatives considered

- **Strictly one pack per intent, built only at G8.** Rejected (#215): a pack that must change (a late escalation, a new CI result) would need an overwrite of stored evidence.
- **Include the diff in the pack.** Rejected (#219): the pack may go to a client and the pilot repository is public. The pull request already shows the change, and the hash proves which diff G5 checked.
- **Approver IDs only in the Markdown.** Rejected (#216): a client asks "who approved?". Names are read at build time, escaped, and purged with the files.
- **One access key for build and read.** Rejected (#218): building writes to the evidence store, reading does not. The second approver reads but does not build.

## 4. Consequences

- The api process holds a second credential and can read client code (§2.2).
- D-05 §6.6 changes meaning (versions); D-03 §5.2, §7.5, §8.2, §10 describe the builder and the identity (D-03 1.25, D-05 1.30).
- E03 seals one version and checks `disclosure` (and `client_text_required`). E05 purges the files and decides object lock. Both get backlog notes.
- The handbook usage sections: Ch.15 §15.10.2 (the pack), Ch.19 §19.8c (the commands), T11 §5h (the credential).

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-10-04 | Claude (task E02) | First version |
