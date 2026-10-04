# @sdlc/config — project configuration

Reads, validates and hashes the per-project configuration (design/D-08 task A05, ADR-M18).

## Use

```ts
import { formatIssue, loadProjectConfig } from '@sdlc/config';

const result = loadProjectConfig(projectYaml); // '' = defaults only
if (!result.ok) {
  // Refused: schema errors or mandatory-rule violations. Text comes from the message catalog.
  result.errors.forEach((e) => log(formatIssue(e)));
} else {
  result.config; // ProjectConfig (frozen), types in @sdlc/contracts
  result.configHash; // store in project_configs.config_hash and in every gate decision
  result.warnings; // allowed loosening: record in the config.changed audit event (ADR-M13)
}
```

## File format

- Defaults: [`defaults/project-config.default.yaml`](defaults/project-config.default.yaml). Every value cites the codes table, a design document or a handbook chapter.
- A project file is a **partial override**. Write only what differs:

```yaml
oversight:
  matrix:
    G2:
      low: { mode: HITL } # tighten: always allowed
escalation:
  calendar:
    holidays: [2027-02-05, 2027-02-08, 2027-02-09, 2027-02-10] # Tết
```

- Mappings merge key by key. Lists, values, durations (`{ value, unit }`) and deadlines (`{ kind }`) replace the default whole. Any mapping with a `unit` or `kind` key counts as a duration or deadline, so new settings must not use those key names for ordinary mappings.
- Unknown settings are refused. YAML tags, duplicate keys and alias bombs are refused.

| Section | Settings |
|---|---|
| `oversight.matrix` | `G1`…`G7`, and `G8.production` / `G8.non_production`; each has `low`, `medium`, `high`, `critical` cells: `mode` (`HITL`, `HOTL`, `AUDIT`; `POLICY` at G4 only), `roles`, `approvals` (default 1), `on_breach` (HITL) |
| `oversight` | `forced_hitl_g3.change_flags`, `dual_approval_g7.change_flags` and `.roles`, `g6_security_findings.mode` and `.min_severity`, `hitl_gate_deadline`, `hotl_block_window`, `approval_expiry`, `gate_overdue.severity` and `.response_level` |
| `autonomy.max_by_risk` | Maximum autonomy per risk tier |
| `escalation` | `sla.<severity>.acknowledge` and `.resolve`; `calendar` (`time_zone`, `working_days`, `working_hours`, `holidays`) |
| `run` | `g6_ci_retries`, `loop_detection.identical_tool_calls_max`, `loop_detection.no_progress_window_minutes`, `failed_run_escalation`, `g5_breach_escalation` and `kill_escalation` (`severity`, `response_level` of the escalation a failed run, a G5 breach or a kill raises) |
| `budget` | `warn_percent`, `stop_percent`, `default_intent_usd`, `default_run_usd` |
| `model_routing.allowed_provider_types` | `api` / `self_hosted` per data class |
| `retention.evidence_retention_days` | Default 180 |
| `github.poll_interval_seconds` | Default 30 |
| `verification.required_checks` | C08: the CI checks G6 waits for, by name; default `[]` (every check). The pilot: `[ci-ok]` |
| `verification.ci_timeout_minutes` | C08: CI still pending after this → paused at G6, technical escalation; default 60, at most 1440 |
| `access.intent_create_roles`, `access.intent_read_roles` | Who may create and read intents through the API (B03, ADR-M26). Default: `person_a` creates; every role reads; creators always read |
| `access.ai_record_write_roles`, `access.ai_record_read_roles` | Who may write and read the project AI record through the API (B12, ADR-M32). Default: `person_a` and `pm_brse` write; every role reads; writers always read |
| `access.spec_link_roles` | Who may link an intent's spec through the API (B08, ADR-M39). Default: `person_a` and `pm_brse` |
| `access.plan_submit_roles` | Who may submit an intent's plan file through the API (B09, ADR-M40). The submitter never approves G3. Default: `person_a` |
| `access.kill_roles` | Who may stop a run with the kill switch (C11, ADR-M42). Default and minimum: `person_a`, `person_b`, `governance` |
| `access.cost_read_roles` | Who may read the cost report of a project or intent (E04, ADR-M45). Default: `person_a`, `person_b`, `pm_brse`, `governance`, `admin`; tenant admins always may; never `viewer` (M28) |

Durations: `{ value, unit }` with `minutes`, `hours`, `days` (wall clock) or `working_hours`, `working_days` (working calendar; one working day = the working hours). Deadlines may also be `{ kind: end_of_working_day }` or `{ kind: next_planned_work }` (no clock).

## Mandatory rules

A project may tighten anything. It may **not** loosen these (rules M1–M28; sources in [`src/mandatory-rules.ts`](src/mandatory-rules.ts)):

| Rule | What |
|---|---|
| M1 | G1 HITL at every tier |
| M2 | G7 HITL at every tier, Person B approves; Critical needs person_b + second_approver |
| M3 | G8 production HITL at every tier, Person B; Critical needs 2 approvers |
| M4, M5 | Forced-HITL G3 and dual-approval G7 lists keep every handbook flag (adding is allowed) |
| M6 | G6 security findings HITL; the `min_severity` threshold always includes critical findings |
| M7 | Autonomy ≤ L2; Critical L0; High ≤ L1; never more autonomy for a higher risk tier |
| M8 | `client_restricted` self-hosted only; `prohibited` no model |
| M9 | Budget warning ≤ 80 %, stop ≤ 100 %, warning before stop |
| M10 | Loop limit ≤ 3 identical tool calls |
| M11 | SLA clocks never longer than codes table §6.3 / handbook Ch.6 §6.4; calendar floor: at least 5 working days per week and 7 working hours per day |
| M12 | `POLICY` only at G4 and without roles; other cells need roles; approvals ≤ roles; no `viewer`; `on_breach` is HITL |
| M13 | High and Critical: G2, G3, G6, G7, production G8 HITL; Critical non-production G8 HITL |
| M14 | G4 High and Critical HITL |
| M15 | G6 never `POLICY` |
| M16 | `viewer` never creates intents (`access.intent_create_roles`) |
| M17 | Escalation routing: `policy` goes to governance, no `viewer`, backup ≠ owner; notify lists keep the handbook's roles |
| M18 | Agent recertification at least every 3 months (`agents.recertification_months` ≤ 3, handbook Ch.20 §20.8) |
| M19 | `viewer` never writes the project AI record (`access.ai_record_write_roles`) |
| M20 | A failed or lost run freezes the intent: `run.failed_run_escalation.response_level` is `pause`, `contain` or `incident` |
| M22 | A G5 breach freezes the intent: `run.g5_breach_escalation.response_level` is `pause`, `contain` or `incident` (C07, ADR-M34 §2.8) |
| M23 | `viewer` never links a spec (`access.spec_link_roles`; B08, ADR-M39) |
| M24 | `viewer` never submits a plan (`access.plan_submit_roles`; B09, ADR-M40) |
| M25 | `access.kill_roles` always holds `person_a`, `person_b`, `governance`, never `viewer` (C11, D-02 FR-34, ADR-M42) |
| M26 | `run.kill_escalation.response_level` is `pause`, `contain` or `incident` (C11, ADR-M42) |
| M27 | `run.loop_detection.no_progress_window_minutes` ≤ 30 (C11 PR 2, D-02 FR-35, ADR-M42 §2.7) |
| M28 | `access.cost_read_roles` never holds `viewer` (E04, ADR-M45) |

Other loosening is accepted with a warning: a looser matrix cell, fewer approvals, a higher G6 security threshold (`min_severity`), a working day swapped out of the calendar, shorter working hours (still ≥ 7), or more than 20 holidays in one calendar year. A Run Contract validity above 60 minutes, a run cap above the default and a no-progress window under 5 minutes (`run.loop_detection.no_progress_window_minutes`: a long silent command may stop a healthy run) also give a warning. Adding working days, a longer day or up to 20 holidays a year gives no warning.

## Changing the defaults

A codes-table change must come with the matching change to the default file **in the same PR**. `platform/tests/config/codes-table-drift.test.ts` fails and names each differing cell otherwise. A change to a default value also changes the pinned hash in `platform/tests/config/hash.test.ts`.
