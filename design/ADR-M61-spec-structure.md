# ADR-M61. The structure of a spec, and G2 needs acceptance criteria

| Item | Value |
|---|---|
| Status | **Proposed** (task S01, for review) |
| Date | 2026-10-08 |
| Decided by | Harry (plan approved 2026-10-08, with answers to QUESTIONS #290–#292) |
| Related | D-08 task S01 (AC1–AC5); D-02 §4.1 item 10, §6.2 (G2 "Acceptance criteria present"), FR-02; D-03 §6 (version 1.34); D-05 §6.2 (version 1.38); D-09 §7, §8; ADR-M30 §2.4b; ADR-M39; ADR-M54 §2.4b; QUESTIONS #285, #290–#292 |

## 1. Context

- D-02 §6.2 says G2 is enforced by "Acceptance criteria present; spec hash recorded". Until S01 the platform recorded the hash only (B08, ADR-M39). G2 passed by HOTL as soon as a spec was linked, and a person could approve any Markdown file.
- The specs the team writes come from Spec Kit, from BMAD, or by hand (D-01 §5.2, D-09 §8). D-02 §4.1 item 10: the spec adapter reads them, it does not convert them. QUESTIONS #285 moves "read their structure" before the trial M-E.
- The text of a spec is client data. The platform keeps its SHA-256 only (ADR-M39 §2.3, QUESTIONS #163).

## 2. Decision

### 2.1. Count in memory, keep a count and a code

- `readSpec` (core `specs/read.ts`) hashes the file and, in the same call, counts its acceptance criteria (`readSpecStructure`, `specs/structure.ts`). Only the SHA-256, a structure code and a count leave the function. The text never reaches a table, a log, an event, Temporal or a notice.
- Both paths that link a spec count it: a person's link (`linkSpecFromGitHost`) and the workflow's link of a changed head (`spec-check.ts`, `head_changed`).
- `spec_refs` gains `structure` (a code) and `acceptance_criteria` (0–10,000), both or neither (migration `0026-spec-structure`, D-05 1.38). Rows still never change. `spec.linked` carries both values.

### 2.2. The formats (pinned versions)

The rules follow the template files of these releases. Compare these files at the next pin upgrade.

| Tool | Release | Commit | Template files |
|---|---|---|---|
| Spec Kit (`github/spec-kit`) | `v1.1.2` | `959e866caa3618bf3dc290d5dca33394365af9c6` | `templates/spec-template.md` |
| BMAD Method (`bmad-code-org/BMAD-METHOD`) | `v6.12.1` | `790dae9c8e2a1d73575cb2d40b14dd4963391f29` | `src/bmm-skills/v6-shims/bmad-create-story/template.md` (story file); `src/bmm-skills/plan/bmad-create-epics-and-stories/templates/epics-template.md` (epics file) |

What counts as one acceptance criterion:

| `source_tool` | Structure code | Where | One criterion |
|---|---|---|---|
| `spec-kit` | `spec_kit` | each `**Acceptance Scenarios**:` block (under `### User Story …`), up to the next heading, bold label or `---` | each top-level list item (`1. **Given** …, **When** …, **Then** …`) |
| `bmad` | `bmad_epics` | each `**Acceptance Criteria:**` block of an epics file | each `**Given**` group (`**When**`, `**Then**`, `**And**` lines belong to it); a block without one counts its list items |
| `bmad` | `bmad_story` | the `## Acceptance Criteria` section of a story file | each top-level list item |
| `manual` or none | `manual_heading` | each heading that contains "acceptance criteria" (any case) or 受入基準, such as `## 受入基準 / Acceptance criteria` (D-09 §8), up to the next heading of the same or a higher level | each top-level list item (the items with the smallest indent) |

- Spec Kit's `FR-xxx` (functional requirements) and `SC-xxx` (success criteria) are not acceptance criteria and never count (QUESTIONS #291).
- **Fallbacks.** When the tool's rule finds nothing, the other rules run: `spec-kit` → manual heading → BMAD epics; `bmad` → epics → story → manual heading → Spec Kit; `manual` or none → manual heading → Spec Kit → BMAD epics. The structure code says which rule matched; `none` with a count of 0 when no rule matched. A spec linked with the wrong tool, or none, is still read.
- **Not counted.** An item that is empty, or that still holds template text (`[initial state]`, `[Add acceptance criteria from epics/PRD]`, `{{precondition}}`), so an unfilled template never passes G2. Markdown links, task-list checkboxes and inline code (`` `^[A-Z]{3}-[0-9]{3}$` ``) are real text. Fenced code blocks and HTML comments are skipped.
- The pilot's ten specs (`harryforge/pilot-order-inventory`, `docs/specs/T01`–`T10`, at `7d5341d87953db8a343d265ac294b56bfc075eb0`) all match `manual_heading`, with 5 to 9 criteria each (PR description of S01).

### 2.3. The G2 rule (QUESTIONS #290, #292)

- G2 passes only when the latest spec has **at least one** acceptance criterion. Same rule at every risk tier and oversight mode; not configuration (#292).
- A spec linked before S01 has no count and is treated as having none (#290: fail closed). Linking the same file again makes a new version with a count (`linkSpecFromGitHost` no longer returns a version without one).
- At G2, when the spec has none, the step (`stepGate`):
  - records a system `fail spec_unclear` once per spec content hash (`gate_decisions.input_sha256`), like G8's `ai_record_missing`;
  - records the notice `spec_unclear` with it (catalog `intent.status.spec_unclear`), to the roles that act at G2;
  - waits with the reason `spec_unclear` (`IntentWaitReason`, U02). The gate deadline still runs.
- The check comes after the spec check of B08 (a changed head links a new version first) and before approvals are counted, so an approval of a pre-S01 spec never moves the gate.
- HOTL: `hotlConditionsHold('G2')` also needs a count of 1 or more.
- HITL: `decideGate` refuses `approve` at G2 with `CommandError('spec_unclear')` (API 422 `spec_unclear`, comment reply `comment.reply.spec_unclear`). `reject` and `request_changes` are accepted.
- A `fail` is never a rejection (`gateHistory`), so the intent stays open. E06 counts people's decisions and the platform's HOTL and AUDIT passes only, so this `fail` changes no statistic. The Evidence Pack lists it like any gate decision.
- G3 and G4 need nothing new: any change of the spec takes the intent back to G2 (ADR-M39 §2.4), where the new version is counted.

### 2.4. Where people see it

- `POST` and `GET /v1/intents/:intent/specs`, and the spec in `GET /v1/intents/:intent`, return `source_tool`, `structure` and `acceptance_criteria` (null before S01).
- `sdlc spec link` prints the tool, the structure and the count, and a warning when the count is 0; `sdlc spec list` shows them per version.
- `sdlc intent show` and the dashboard show the waiting reason `spec_unclear`.

## 3. Consequences

- G2 now enforces D-02 §6.2. A spec without criteria stops at G2 instead of reaching the agent.
- Spec authors write criteria as list items under a recognised heading or block. A paragraph of prose under the heading counts 0 and fails closed.
- A new Spec Kit or BMAD layout that the rules do not know falls back to the manual heading rule, or counts 0 and fails closed. A pin upgrade is a code change: compare the template files in §2.2, update the rules and the fixtures in `platform/tests/specs/fixtures/`.

## 4. Not done here

- Checking that criteria are good (testable, unambiguous): Person A and Person B judge that at G2.
- Reading other structure (requirements, user stories, tasks). S02 reads Spec Kit tasks and BMAD stories for `sdlc plan draft`.
- Converting specs into the platform's own format (MVP+1, D-02 §4.2).
