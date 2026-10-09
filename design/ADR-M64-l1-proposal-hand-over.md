# ADR-M64. Taking an L1 proposal forward: the download and the end of the intent

| Item | Value |
|---|---|
| Status | **Proposed** (task C13, PR 1: design; PR 2: code) |
| Date | 2026-10-09 |
| Decided by | Harry (C13 plan approved 2026-10-09, with answers to QUESTIONS #335–#337) |
| Related | D-08 task C13; D-02 FR-03, FR-10, FR-11; D-03 §6 (L1 runs, state machine), §7.5; D-09 T09; ADR-M30 §2.2 (only the workflow moves an intent), ADR-M33 §2.9 (the proposal as evidence), ADR-M48 §2.2–§2.3 (the api's evidence identity, the hash check); handbook Ch.13 §13.10.4, Ch.19 §19.8c; QUESTIONS #335–#337 |

## 1. Context

At High risk the agent runs at L1 (FR-03): it works in its sandbox, nothing is pushed, and the runner stores the result as a **proposal**, a patch against the start commit (ADR-M33 §2.9). The run ends `succeeded_proposal_only`; the intent is `paused` at G4 and waits (`proposal_review`). The handbook says Person A takes the proposal forward, for example as a pull request a person writes, or as a new intent.

Two things were missing (found in the review of the user commands, 2026-10-09):

- **Nobody can get the patch.** The handbook says "ask the platform operator", but no command reads a proposal: only the api's evidence identity may read `evidence/proposals/*`, and only to check hashes when it builds a pack.
- **Nobody can end the intent.** `stepPaused` (core `workflow/run-lifecycle.ts`) waits for ever after a proposal; no escalation is raised, so `terminate` is not available either. The trial M-E task T09 would stop there.

## 2. Decision

### 2.1 The download (QUESTIONS #336)

- `GET /v1/intents/:intent/runs/:run/proposal` returns the stored patch of one run; `sdlc evidence proposal <INT-…> [--run <run ID>] --output <file> [--force]`. Without `--run`, the latest run of the intent with a proposal.
- **Who:** the roles in config `access.evidence_read_roles` (rule M30: never `viewer`), tenant admins always; the same answers as the other evidence reads (no role → 404, another role → 403).
- **The api reads it** with its existing identity `api-evidence` (`Read:evidence/proposals/*`, ADR-M48 §2.2), at most `SDLC_API_EVIDENCE_MAX_ITEM_MB` and at most **32 MiB** (`PROPOSAL_MAX_BYTES` in `@sdlc/contracts`: the whole patch travels in one JSON answer, so the api's and the CLI's memory stay bounded; a larger proposal answers `evidence_too_large`), and checks its SHA-256 and size against `evidence_items` **before** it answers: a mismatch is refused (fail closed) and audited `evidence.check_failed`, as when a pack is built. Without the credential: 503 `evidence_unavailable` after the access check.
- **Every download is audited:** a new action `evidence.proposal_read` (the run ID, the SHA-256, the size; never a path or the content).
- **The patch is client code.** The answer is JSON like the pack file endpoint: `media_type` `text/x-diff`, the SHA-256, the size and the bytes in **base64** (a patch is bytes: a file in Shift_JIS must reach the person unchanged; as built in PR 2). The answer has `Cache-Control: no-store`. The CLI raises its answer cap for this one call (32 MiB in base64), checks the size and the hash again and writes the file with mode 600, never to standard output, never over an existing file without `--force` (then through a temporary file and one rename: a failed write keeps the old file, a link is replaced, never followed). Without `--run` the CLI takes the latest run that ended `succeeded_proposal_only` from `GET /v1/intents/:intent/runs`. The api never logs or keeps the bytes. The read-only dashboard never shows a proposal.

### 2.2 The end of the intent (QUESTIONS #335)

- Person A ends the intent with the existing gate command: **`sdlc gate reject G4 <INT-…>`** (or `/reject G4` on the intent's issue), with a reason code and, as `--reason-ref`, a link to where the work continues (the pull request a person wrote, or the new intent's issue).
- `decideGate` accepts this one more case: a `reject` at G4 while the intent is `paused` at G4 after an L1 proposal (`proposal_review`). Every other paused case keeps its escalation path; `approve` and `request_changes` stay refused there (`gate_not_current`).
- **Who:** a holder of G4's role at the intent's risk (Person A by default). A rejection is not an approval: the person who allowed the run (`triggered_by`) may reject it, as they may kill a run (FR-11 is about approvals).
- **The workflow ends the intent**, as for every rejection (ADR-M30 §2.2): the next step reads the rejection (recorded after the pause, by audit `seq`), moves the intent to `rejected` with the gate decision, the audit event and the status comment (`rejected`). No new intent status, no new endpoint for this part.
- Why not `done`: `done` means G8 passed and the pack is sealed (FR-43, every G8 HITL); the proposal never went through G5–G8. Why not a new command: it would be a second way to end an intent beside the gate decisions, with its own rules.

### 2.3 Scope (QUESTIONS #337)

Only the L1 proposal case. Withdrawing an intent at any gate (a running run, a pull request open, an escalation open) stays for M-F: it needs the kill switch and the escalations together.

## 3. Consequences

- T09 can finish in the trial M-E: the proposal is read by a person, then the intent ends `rejected` with a link to where the work went.
- A fourth process path reads client code (the api, on a person's request); each read is audited, checked and capped.
- The rejection has no `waited_seconds` (the intent did not wait at the gate for it; as for a block of a passed gate), so the gate waiting-time metrics (E06) leave it out.
- The state machine (D-03 §6, diagram D12) gains `G4 → Rejected` after a proposal.

## 4. Rejected

- **The operator copies the patch with S3 tools:** no identity for it, no audit, no hash check.
- **A new `sdlc intent close` with `cancelled` or `done`:** a second way to end intents; `done` would skip G8.
- **An escalation raised at the proposal, decided `terminate`:** the proposal is the expected result of an L1 run, not a breach; an escalation would start SLA clocks and reminders for normal work.

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-10-09 | Claude Code (task C13, PR 1) | The download, the end of the intent by a G4 rejection, the scope |
| 0.2 | 2026-10-09 | Claude Code (task C13, PR 2) | As built: the answer is JSON with the bytes in base64; the CLI finds the latest run with a proposal; the rejection has no `waited_seconds`; after the code review: the 32 MiB cap, `no-store`, `--force` through a rename |
