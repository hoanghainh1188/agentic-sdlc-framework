# ADR-M49. Gate G8: release approval, sealing the Evidence Pack, closing the intent

| Item | Value |
|---|---|
| Status | **Proposed** (task E03, for review) |
| Date | 2026-10-04 |
| Decided by | Harry (plan approved 2026-10-04, with answers to QUESTIONS #220–#222) |
| Related | D-08 task E03 (AC1–AC3); D-02 FR-10, FR-11, FR-12, FR-17, FR-40, FR-43, §6.2, §10; D-03 §5.2, §6, §6.1, §8.2, §10 (version 1.26); D-05 §6.2, §6.6 (version 1.31); codes table §4 row G8; handbook Ch.15 §15.4, §15.5 Step 4, §15.8, §15.10.3; ADR-M28, ADR-M30, ADR-M38 §2.7, ADR-M41, ADR-M48; QUESTIONS #16, #215–#217, #220–#222 |

## 1. Context

After G7 a person merged the approved commit, and the intent waits `in_gate G8` (ADR-M41 §2.5). G8 is the last gate: the release. Handbook Ch.15 §15.4: approvals are bound to the exact version, and for G8 that is the artifact digest. FR-43: the release record holds the client AI disclosure note, and G8 fails without it. E02 built the Evidence Pack (ADR-M48) and left three items to E03: sealing one version, the disclosure check for the client's own format, and how the worker builds the pack at G8.

The platform never deploys (D-02 §4.2). In the MVP the release is the merge plus the delivery to the client; the client deploys (Ch.15 Step 3).

## 2. Decision

### 2.1. The order at G8

- **The release pack.** Building reads every stored evidence file back and checks its hash (ADR-M48 §2.3): minutes, longer than the step activity's one-minute limit. So the step never builds:
  - under the intent lock, the step recomputes the pack's hashes from the database alone (`currentPackHashes`: no file is read; the items the build just checked count as verified);
  - when the latest version is not current, the step returns the new outcome `build_pack`; the workflow calls the worker activity `buildReleasePack` (15 minutes, one attempt) and steps again;
  - the activity is idempotent: the same content returns the existing version. A store that fails, a file above the size cap or concurrent builds → `unavailable` (logged as `worker.release_pack_unavailable` with the code), and the workflow tries again a minute later.
- **Under the lock, in order** (`core/workflow/g8.ts`):
  1. a person's rejection → `rejected`; a request for changes → the intent stays at G8, the gate clock starts again, and approvals recorded before it no longer count (`gateHistory`). The change is merged: a fix needs a new intent (notice `g8_changes_requested`);
  2. no project AI record → no disclosure note → a system `fail ai_record_missing`, once per merge, notice `g8_refused`; the intent waits (AC2);
  3. the pack is not current → `build_pack` (or `evidence_unavailable` without the worker's identity);
  4. the approvals bound to the G8 input are re-checked (FR-17); a `void` is a new decision, so the pack is built again first;
  5. approvals complete: the G8 overdue escalation is closed (the pack is built again: it lists the closed escalation); every HOTL block window must be closed (`hotlBlockWindowOpenUntil`, no gate hard-coded); `release` must not be frozen (ADR-M28 §2.4); then **seal** the latest version, record `evidence.pack_sealed` and `intent.closed`, and move the intent to `done` (notice `released`);
  6. otherwise: the gate deadline (FR-12, subject `g8_input`) and the notice `g8_review_needed`, once per stay.
- **The sealed version** is the latest one: it lists every G8 approval (FR-40: "the 8 gate decisions"), and its manifest shows the intent `in_gate G8`, its state when sealed. Sealing is once: the repository updates only an unsealed row, the trigger keeps `sealed_at` set once, and the index allows one sealed version per intent.

### 2.2. What G8 binds: the release hash

- A G8 approval cannot be bound to the pack's `content_sha256`: the pack lists the G8 decisions, so each approval would void the others.
- Every pack stores **`release_sha256`** (migration `0022-gate-g8`): the SHA-256 of the canonical manifest content **without the G8 parts**: the G8 gate decisions and the escalations raised at G8 (`packet.gate = G8`). Null for versions built before E03; fixed once written (trigger `SDA14`, extended).
- **The G8 input** = SHA-256 of `{v: 1, run_id, pr_number, head_sha, merge_commit_sha, release_sha256}`: the merged run (run event `pr_merged`) and the latest pack's release hash. It is computed from the database alone, so `/approve G8` needs no evidence store. No pack yet → `gate_input_missing`.
- Effect:
  - any change of the evidence before G8 (an item, an escalation, CI, the cost, the AI record's disclosure facts) makes a new release hash: earlier G8 approvals are voided (`input_mismatch`);
  - a new G8 approval makes a new pack version with the same release hash: the other approvals stay valid.
  - an approval given while the latest version is stale (the evidence changed and the step has not rebuilt yet) is bound to the old release hash and is voided at the next step: fail closed; the person approves again.

### 2.3. Who approves (QUESTIONS #220)

- **Every G8 is production in the MVP**, so always HITL (`GateContext.environment = production`). The matrix gives Person B, and at Critical risk Person B **and** the second approver (rule M3, `G8.production.critical`): the codes table's "business/security owner" is the `second_approver` role (D-02 §3). The non-production HOTL path and a per-project `release.environment` are MVP+1.
- **Producers never decide G8** (FR-11): the producers of the merged change, as at G7 (ADR-M41 §2.4): the intent's creator (QUESTIONS #16), the people who allowed its runs, the plan submitters. `decideGate` refuses their approve, reject and request for changes. Bots never decide (the poller), agents have no decide path.
- People decide by the CLI (`sdlc gate approve|reject|request-changes G8`), the API or a comment (`/approve G8`). Every gate G1–G8 is now decided by a command; G8 only while the intent waits there.

### 2.4. Recording the release (AC3)

- `evidence.pack_sealed`: the pack, its version, its content hash and the release hash G8 approved.
- `intent.closed` ("record metrics"): the sealed pack and its version, the release hash, `lead_time_seconds` (from the intent's creation to the release), `runs`, `g7_change_requests`, `cost_usd` (decimal string), `input_tokens`, `output_tokens` (digit strings, as E04). A new audit field kind `count` (an integer of 0 or more) carries the counts. No new table.
- The G8 decisions carry `waited_seconds` like every other gate, so E06's gate metrics include G8.

### 2.5. A failed evidence check at G8 (QUESTIONS #221)

- A stored evidence file changed or missing while the release pack is built (`evidence_hash_mismatch`, `evidence_missing`) may be tampering. The activity stops G8 in one transaction under the intent lock: audit `gate.g8_check_failed`, a `security` escalation bound to the G8 input (level `run.failed_run_escalation`, rule M20), `paused` at G8, notice `g8_escalated`.
- `stepPausedG8` acts on the decision, re-checked just before acting (FR-17): `resume` → back to `in_gate G8`, where the pack is built again (and stops again if a file still fails); `terminate` → `cancelled`; an escalation closed without a decision → back to G8.
- Diagram D12: G8 → Escalated, Escalated → G8, Escalated → Cancelled.

### 2.6. The client's own disclosure format (QUESTIONS #222)

- For `client_format` (`client_text_required: true`, ADR-M48 §2.5), **Person B's G8 approval confirms that the client's note is ready**. The release hash binds the disclosure facts (`format`, `client_text_required`, `record_ref`), so a changed format or link voids the approval. The notice `g8_review_needed` says the client's format applies and links the human AI record.
- An explicit confirmation by a `pm_brse` holder (the role that writes the note, Ch.15 §15.3) is MVP+1.

### 2.7. The worker's evidence identity

- The worker builds the release pack with its own SeaweedFS identity **`worker-evidence`**: the same four rights as `api-evidence` (read `evidence/proposals/*`, `evidence/diffs/*`, `evidence/packs/*`; write `evidence/packs/*`), stored at `kv/worker/evidence` by `pnpm openbao:bootstrap worker-evidence-credentials` (runbook T11 §5i). The `worker` AppRole already reads `kv/data/worker/*`: no policy change. The api and the worker share one bootstrap helper (`pack_evidence_credentials`).
- Settings `SDLC_WORKER_EVIDENCE_URL` (`off`), `_BUCKET`, `_SECRET_PATH` (`worker/…`), `_MAX_ITEM_MB` (256). Without the credential the worker logs `worker.evidence_missing` at start and intents wait at G8 (`evidence_unavailable`); people's rejections are still handled.
- **Three processes can now read client code** in the evidence store: the runner (diffs, to push), the api (proposals and diffs, Evidence Packs on request) and the worker (proposals and diffs, the release pack). Each has its own key and the same limits: read only on those prefixes, capped per item, one item at a time, the bytes hashed and dropped, never logged or kept. Write includes delete under `packs/` (ADR-M48 §2.2); object lock is E05's.

## 3. Alternatives considered

- **Bind G8 to `content_sha256`.** Rejected: each G8 approval changes the content and would void the others.
- **Seal the pack built before the approvals.** Rejected: the sealed pack would not list the G8 decisions (FR-40).
- **The api builds the pack on a signal from the worker.** Rejected: the worker would need an API identity and a service-to-service call path.
- **Share `api-evidence` between processes.** Rejected: one key in two places, and the store's access log cannot tell the processes apart.
- **Build in the step activity.** Rejected: reading large diffs takes longer than its one-minute limit, and an HTTP call under the intent lock blocks every other move of the intent.

## 4. Consequences

- One intent can go G1 → G8 and end `done` with a sealed Evidence Pack (D-02 §10 item 1).
- Every G8 approval and every change of the G8 escalations adds a pack version: a few more small files for E05 to purge.
- A late cost record during G8 (C12, the scheduled spend sync) changes the release hash and voids G8 approvals: unlikely (runs end long before G8), noted for C12.
- `gate_not_supported` is no longer reachable by a command (every gate is decidable); the guard stays.
- Handbook Ch.15 §15.10.3 (G8), Ch.19 §19.8c (the commands) and T11 §5i (the worker's identity) describe the usage.

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-10-04 | Claude (task E03) | First version |
