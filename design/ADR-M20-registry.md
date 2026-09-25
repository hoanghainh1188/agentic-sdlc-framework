# ADR-M20. Registry: intents, gate decisions, POLICY, void links, reason codes

| Item | Value |
|---|---|
| Status | **Proposed** (task B02, PR for review) |
| Date | 2026-09-25 |
| Decided by | Harry (plan approved 2026-09-25: D1–D4 and reason codes) |
| Related | D-05 sections 5, 6.2, 6.3, 10 (version 1.4); D-02 FR-01, FR-03, FR-10, FR-11, FR-17; D-03 sections 6, 6.1, 6.2, 6.3; D-08 task B02; ADR-M09 section 2.8; QUESTIONS #6, #16, #21, #22 |

## 1. Context

Task B02 creates the registry tables `intents`, `spec_refs`, `plans` and `gate_decisions` (D-05 sections 6.2 and 6.3). D-05 left four points open:

- How `gate_decisions` stores the automatic policy check at G4 (`POLICY`, QUESTIONS #6). `oversight_mode` has only HITL, HOTL and AUDIT.
- How a `void` decision says which approval it cancels (D-03 section 6.3).
- How the code `INT-YYYY-NNNN` is numbered per tenant without races, and which clock sets the year.
- How a gate decision explains a rejection. D-05 had a free-text `reason`. Gate decisions are append-only and kept at least 2 years (D-05 section 10), so free text (names, client details) could never be erased. This is the same problem that A07 solved for audit payloads (handbook Ch.7, FR-44).

## 2. Decision

### 2.1. `gate_check_mode` for POLICY (D1)

- New enum `gate_check_mode` with `HITL`, `HOTL`, `AUDIT`, `POLICY`. The column `gate_decisions.oversight_mode` uses it and stays `NOT NULL`.
- The values match `GateCheckMode` in `@sdlc/contracts` (`GATE_CHECK_MODES`), which the policy engine returns. The stored mode is exactly what the engine resolved.
- A CHECK allows `POLICY` only at `G4` with `actor_type = system`.
- The enum `oversight_mode` (HITL, HOTL, AUDIT; codes table §2.2) is not created yet: no table uses it.
- Not chosen: `oversight_mode` null for POLICY. "Null" can also mean "forgot to set it", and every reader would have to infer POLICY from null.

### 2.2. `voids_decision_id` (D2)

- New column `gate_decisions.voids_decision_id uuid NULL`.
- A CHECK makes it non-null exactly when `decision = 'void'`.
- Foreign key `(tenant_id, intent_id, gate, voids_decision_id) → gate_decisions (tenant_id, intent_id, gate, id)`: a void cancels a decision of the same tenant, intent and gate.
- An insert trigger checks that the target is an `approve` (SQLSTATE `SDA04` → `DbError('invalid_value')`).
- A partial unique index voids each approval at most once.
- With dual approval, each approval gets its own void row.
- Not chosen: "a void cancels every earlier approval at that gate". It needs a reliable order, and rows written in one transaction share the same `now()`.

### 2.3. Intent codes (D3)

- The year is the **UTC** year of the registry clock (D-05 D5). The registry clock is injectable for tests.
- In one transaction: take the advisory lock `pg_advisory_xact_lock(<intent-code class>, hashtext(tenant_id))`, read the tenant's highest number for the year, and insert the next one.
- The number has at least 4 digits. After 9999 it grows (`INT-2026-10000`); the CHECK allows up to 9 digits.
- Numbering starts again at `0001` each year. Old codes stay unique because they carry their year.
- `UNIQUE (tenant_id, code)` is the backstop if a writer skips the lock.
- No counter table: the tenant guard refuses `ON CONFLICT DO UPDATE`, and intents are never deleted (D-05 D7), so numbers are never reused.

### 2.4. Optional audit fields (D4)

- `AUDIT_ACTIONS` may declare a field as optional with a trailing `?` (for example `approver_role: 'code?'`).
- An optional field may be left out, never set to null. When present, it follows the same format rule.
- Actions stay declared per action, with the same 2048-byte limit (ADR-M09 section 2.8).

### 2.5. Reason codes instead of free text

- `gate_decisions` has no `reason` column. It has:
  - `reason_code gate_reason_code NULL`, from a fixed list in `@sdlc/contracts` (`GATE_REASON_CODES`): `spec_unclear`, `tests_insufficient`, `security_finding`, `out_of_scope`, `policy_denied`, `budget_exceeded`, `ci_failed`, `ai_record_missing`, `data_class_not_allowed`, `expired`, `input_mismatch`, `scope_mismatch`, `other`.
  - `reason_ref text NULL`: an optional `https://` link (at most 512 characters) to the Git host comment that holds the human explanation. The text stays on the Git host, where it can be edited or deleted.
- A CHECK requires `reason_code` for `reject`, `request_changes`, `block`, `fail` and `void`.
- Beyond Harry's list, `budget_exceeded`, `ci_failed`, `ai_record_missing` and `data_class_not_allowed` cover the system failures at G1, G5 and G6. Adding a value later needs a migration (ADR-M09 section 2.5).

### 2.6. Where the rules live

| Rule | Source | Where it is enforced |
|---|---|---|
| Maximum autonomy by risk; `prohibited` → L0 | Config `autonomy.max_by_risk`, `model_routing` | `PolicyEngine.maxAutonomy` at intent creation |
| Oversight mode per gate and risk; forced HITL at G3; G6 threshold; G5 `on_breach`; dual approval at G7 | Config `oversight.*` | `PolicyEngine.oversightMode` on every decision |
| Who may approve; producers never approve; two different people | Config roles; mandatory rules | `PolicyEngine.canApprove` on every approval |
| Approval expiry and working calendar | Config `oversight.approval_expiry`, `escalation.calendar` | `deadlineFrom` when an approval is stored |
| Default intent budget | Config `budget.default_intent_usd` | Intent creation |
| Code format, `draft` at creation | D-02 FR-01 | Code and CHECK |
| Agents never decide | D-02 FR-11 | Code and CHECK |
| Reason code required | D-05, this ADR | Code and CHECK |
| POLICY only at G4, by the system | QUESTIONS #6 | Code and CHECK |
| No system `pass` at a HITL gate | D-03 section 6 ("no gate is ever auto-approved by silence") | Code |
| A G5 breach never passes, at any tier | QUESTIONS #21 | Code |

- Core never imports the policy adapter (ADR-M16 section 2.5). The apps pass a `PolicyFactory` (`createSimplePolicyEngine`) to the `Registry`. The registry loads the project configuration in force (stored override YAML merged onto the defaults, ADR-M18), refuses a stored `config_hash` that does not match it, and stores that hash in every gate decision.
- Callers pass the producers per gate (QUESTIONS #16). The registry has no creator rule.

### 2.7. How gate decisions are written

- Rows are only inserted, through `decide` and `revalidateApprovals`. Both hold a per-intent advisory lock, so two approvals of the same gate cannot race past `canApprove`. The audit lock is always taken last.
- A human `approve` stores `approver_role`, `input_sha256`, `scope` (codes only, compared as sets through RFC 8785 canonical JSON) and `expires_at`.
- Other human decisions need one of the gate's roles.
- Dual approval counts approvals bound to the same `input_sha256` that have not expired. Their scopes may differ; each approval is checked against the scope of the protected action by `revalidateApprovals`, so an approval with another scope is voided before the action.
- `revalidateApprovals` checks each current approval against the current input hash, scope and time. It writes one `void` per invalid approval (system actor, reason `expired`, `input_mismatch` or `scope_mismatch`; when several apply, the first in this order). The caller (B07) calls it just before the protected action.
- Every write appends an audit event in the same transaction: `intent.created`, `intent.state_changed`, `spec.linked`, `plan.submitted` and `gate.decided`. Payloads hold IDs, codes, hashes and versions only. They never hold titles, paths, summaries or reasons.

## 3. Consequences

- D-05 version 1.4: `gate_check_mode`, `gate_reason_code`, `voids_decision_id`, `reason_code` / `reason_ref` instead of `reason`.
- `plans.summary`, `intents.title` and `intents.description` hold client text in tables that the platform never updates. The project archive purge (E05, FR-44) needs the maintenance role of ADR-M09 section 2.3 to clear them.
- `intents.max_autonomy` is fixed at creation. G4 must use the stricter of the stored value and the value from the current configuration (QUESTIONS #22, C06).
- B07 must pass the correct producers per gate; B02 cannot check who they are.

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-09-25 | Claude (task B02) | First version |
