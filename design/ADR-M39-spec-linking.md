# ADR-M39. Spec linking and the spec hash check

| Item | Value |
|---|---|
| Status | **Proposed** (task B08, for review) |
| Date | 2026-10-03 |
| Decided by | Harry (plan approved 2026-10-03, with answers to QUESTIONS #160–#164) |
| Related | D-08 task B08 (AC1, AC2); D-02 FR-02, FR-17, FR-19; D-03 §6 (version 1.17), §7.1; D-05 §6.2 (version 1.22); D-09 §7 and scenario N4; ADR-M20, ADR-M23, ADR-M26, ADR-M30, ADR-M33 §2.3, ADR-M36; QUESTIONS #109, #160–#164 |

## 1. Context

The registry has stored linked specs since B02 (`spec_refs`: path, commit, content hash, version). Until B08:

- Only the tests linked specs, with a hash they computed themselves. No API, CLI or comment command linked one, and nothing read the file from the Git host.
- G2's HOTL condition was "a spec is linked" (B07). G4 refused a run when the latest spec was not the one G2 passed (C06), but the intent then waited at G4; nothing took it back to G2.
- D-02 FR-02 asks: "If the spec content changes after G2 → report the mismatch, require G2 again" (scenario N4 of D-09).

B08 must settle what "the spec changed" means, where the platform checks it, and what a spec may be.

## 2. Decision

### 2.1. The spec is the file on the default branch (QUESTIONS #160)

- A linked commit never changes. Checking only that commit would never notice an edit.
- G4 starts the run from the head of the project's default branch (`base_sha`, QUESTIONS #109). The agent therefore reads the spec as it is at that head.
- So **the spec of an intent is the file at its path on the head of the default branch**. The platform checks the file there, and the run starts from the same commit:
  - The step reads the head once (`getBranchHead`). The spec check and G4's facts (`gatherG4Facts(…, headSha)`) both use that one read, so the spec checked is the spec the run starts from.

### 2.2. Linking a spec (AC1, QUESTIONS #162, #164)

- **API**: `POST /v1/intents/:intent/specs` with `path`, optional `commit_sha` (40 hex) and optional `source_tool` (`spec-kit`, `bmad`, `manual`); `GET /v1/intents/:intent/specs` lists the versions. **CLI**: `sdlc spec link <INT> --path … [--commit …] [--tool …]` and `sdlc spec list <INT>` (ADR-M36 pattern, `--json`).
- **Who**: a role in project configuration `access.spec_link_roles` (default `person_a`, `pm_brse`). Mandatory rule **M23**: `viewer` is never in the list. No role on the project → 404 `intent_not_found`; a read role only → 403 `forbidden`. Reading the versions follows `access.intent_read_roles`.
- **When**: the intent is `draft` or waits at G1–G4 (`in_gate`). Otherwise 409 `spec_link_not_allowed`. A spec linked while the intent waits at G3 or G4 takes it back to G2 at the next step (§2.4).
- **How** (`linkSpecFromGitHost`, `@sdlc/core` `specs/`):
  1. The path must be a safe relative path to a Markdown file (§2.3).
  2. The platform reads the head of the default branch and the file there.
  3. Without `commit_sha`, the head is recorded as the commit. With `commit_sha`, the file at that commit must hash the same as the file at the head; otherwise 409 `spec_not_on_default_branch`.
  4. Under the intent lock, the state is checked again and a new version is linked. The same path and content as the latest version links nothing new (the latest version is returned).
  5. The API wakes the intent's workflow.
- **Errors**: an invalid path or an unreadable file → 422 `spec_invalid` with the reason (`invalid_path`, `missing`, `not_a_file`, `too_large`, `not_utf8`); a Git host failure → 503 `git_host_unavailable`; nothing is linked. Texts come from the catalog (`spec.error.*`, `api.error.*`).
- **The api process holds the GitHub App key** from now on: it reads `kv/shared/github-app`, which its OpenBao policy already allows (QUESTIONS #42). Its OpenBao client now stays open, because the GitHub adapter reads the key again from time to time (ADR-M23 §2.2). New setting `SDLC_API_GITHUB_API_URL` (default `https://api.github.com`, `https://` only; completes ADR-M26 §2.6). In development mode without OpenBao there is no Git host: linking answers 503 and the start logs `api.git_host_off`.
- **No comment command** (QUESTIONS #164): a path in a comment is free text, and the command would need new grammar, receipts and replies. API and CLI only.

### 2.3. What a spec may be (QUESTIONS #163)

These are design rules, in code (`specs/rules.ts`), not configuration:

- **Markdown only**: the path ends in `.md` or `.markdown` (any case). The MVP spec adapter reads Markdown only (D-01 §5.2, D-02 §4.1).
- **A safe relative path**: no leading `/`, no `\`, no `.` or `..` segment, at most 1024 characters, not a folder.
- **At most 256 KiB** (`SPEC_MAX_BYTES`). The GitHub adapter's own limit is 1 MiB.
- **UTF-8 text**. The adapter decodes strictly and keeps a byte-order mark, so the stored SHA-256 equals the SHA-256 of the file's bytes (`sha256sum`).
- **Hash only**: the content is hashed and dropped at once. It is client data and stays in the repository (D-05 §2). `spec_refs` keeps the path, the commit and the hash; the audit log keeps the version, the hash, the commit and the cause, never the path.

### 2.4. The check before G3 and before the run (AC2, QUESTIONS #161, #163)

Whenever the intent waits at **G2, G3 or G4** (`in_gate`), the step reads the head and the latest spec's file there **before** its transaction (`gatherSpecFacts`; no HTTP call under the intent lock, like G4). Under the lock, after a person's block of an earlier gate (which wins), `checkSpec` decides:

| Finding | At G2 | At G3 or G4 |
|---|---|---|
| The content at head differs from the latest spec | A new spec version (actor `system`, commit = head, `spec.linked` cause `head_changed`), notice `spec_changed`; G2 evaluates again | The same new version, and **back to G2**, notice `spec_changed` |
| The latest spec is not the one G2 passed (a person linked another one) | — | **Back to G2**, notice `spec_changed` |
| The file cannot be read at head (removed, renamed, not a file, too large, not UTF-8) | **Held** (`spec_unavailable`) until the file is back or a person links a spec that can be read | **Back to G2**, where it is held |
| The Git host cannot be read | **Held** (`git_host_unavailable`, tried again after 60 s); never passes | G3: the same. G4 waits as before (it needs its facts) |
| Otherwise | The step goes on | The step goes on |

- **A held gate refuses only the advance** (code review of B08): a person's rejection, request for changes or block of a passed gate is still handled, and the gate's deadline and overdue escalation still run. Only an approval or a HOTL pass cannot move the intent on.
- **Approvals of the old spec** (FR-17): when the intent goes back to G2, the platform voids the current approvals of G2 up to the gate it left (`void`, `input_mismatch`), like C07's return to G3. They would not count anyway (ADR-M30 §2.4), and voiding them lets the same people approve again. At G2 itself the approval binding (`revalidateApprovals`) voids every approval of the old hash.
- **G2 again** (QUESTIONS #161): the oversight matrix decides. At Low risk G2 is HOTL, so the platform may pass the new spec again, with its block window and a notice to Person A. A project that wants a person sets G2 to HITL in its configuration. No new hard rule.
- **An unreadable spec** is recorded once per spec version and cause (`spec.unavailable`: spec version ID, cause, head commit) with one notice `spec_unavailable`; the step does not repeat it on every wake.
- **Sending the intent back is never frozen**: it stops work, it does not advance (ADR-M28 §2.7). The gate's overdue escalation, if any, is closed (as `sendBack` does).
- **G4's own check stays** (`spec_changed`, ADR-M33 §2.4): a second line of defence when the step runs without the spec check.
- **Wiring**: `StepDeps.specs` (`{ gitHost }`). The worker always wires it (static test); without it (tests of other gates) the step does not check the spec.
- The head is read before the lock: if it moves again in between, the step checks the spec at the head it read, and G4 binds that same head as `base_sha`. The run then starts from a head that is already a little old; the next wake reads again. This is consistent and accepted.
- `spec.unavailable` is recorded once per spec version and cause: a file that disappears a second time is not announced again (the intent still goes back to G2).
- A spec edit while the intent waits for a decision is noticed at the next wake (a signal, a comment, or the reconcile loop). Every move from G2, G3 or G4 happens in a step that read the head first, so a stale spec never advances.

### 2.5. Catalog and data

- New notice kinds `spec_changed`, `spec_unavailable` (`intent.status.*`); new waiting reason `spec_unavailable`.
- New audit action `spec.unavailable`; `spec.linked` gains the optional fields `commit_sha` and `cause` (`linked`, `head_changed`).
- New configuration key `access.spec_link_roles` (the default `config_hash` changes; stored configurations are re-hashed at start, ADR-M37 §2.5).
- No migration: `intent_notices.kind` is a code pattern, and `spec_refs` already has every column.

## 3. Consequences

- G2, G3 and G4 depend on the Git host being reachable: when GitHub cannot be read, intents wait at those gates (fail closed).
- A commit on the default branch that edits a spec under review sends the intent back to G2, also when the edit is small. This is intended (N4): the agent reads the head version.
- One extra GitHub call per step at G2–G4 (the head) plus one file read. The poller's API quota is shared; the step runs on wakes, not on a timer.
- The api process now keeps an OpenBao token alive (AppRole `api`: `kv/api/*` and `kv/shared/github-app` only) and holds the GitHub App key in memory, like the worker. The api is the user-facing process: a compromise of it now exposes a key that can mint installation tokens for every repository where the App is installed (security review of B08). Accepted for the MVP; narrower options (a separate read-only App, or the worker reading the file for the api) are possible later. The api's adapter downloads at most 256 KiB per file (`maxFileBytes`).
- Each link costs two or three GitHub calls and shares the App's rate limit with the poller. The api's general rate limit applies (120 requests per minute per token); a stricter limit for this endpoint can follow if it is abused.
- A person with a link role learns whether a Markdown file exists at a path of the project's repository, and its SHA-256. Such a person normally has read access to the repository; a project that needs less can be served by a spec folder rule later.
- Anyone who can push to the default branch can send intents at G3 or G4 back to G2 by removing or editing their spec. This fails closed and is audited.

## 4. Not done here

- A comment command `/spec` (QUESTIONS #164).
- Converting BMAD or Spec Kit output into the platform's own format (D-02 §4.2, MVP+1).
- Checking that a linked commit is an ancestor of the default branch: the content comparison with the head (§2.2) is what matters for the run.
- The spec as evidence (E02 collects "spec + hash", FR-40).
