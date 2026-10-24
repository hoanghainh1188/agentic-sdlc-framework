// Migration 0042: the G5 secret scan (design/D-05 section 5, version 1.63; D-08 H04; design/ADR-M93
// §2.4; QUESTIONS #586–#590). Rules for every migration: see the header of 0001-tenancy.ts and
// design/ADR-M09. Migrations 0001–0041 are merged and never edited.
//
// - Two G5 reason codes: `secret_in_diff` (the runner's scan found a secret in the run's added
//   lines) and `secret_scan_failed` (the scan failed, or no scan was recorded).
// - The run event `secrets_scanned` needs no change: its values (codes, counts, a SHA-256 and the
//   rule codes joined by `:`) already pass `run_event_payload_is_coded`.
import { defineMigration } from './define.js';

const OLD_REASON_CODES = `('spec_unclear', 'tests_insufficient', 'security_finding', 'out_of_scope',
  'policy_denied', 'budget_exceeded', 'ci_failed', 'ai_record_missing', 'data_class_not_allowed',
  'expired', 'input_mismatch', 'scope_mismatch', 'agent_not_runnable', 'instructions_mismatch',
  'autonomy_not_allowed', 'instructions_unpinned', 'run_cap_reached', 'merged_before_approval',
  'tool_not_runnable', 'other')`;

export const migration0042DiffScan = defineMigration({
  up: [
    // PostgreSQL 12+ allows ADD VALUE in a transaction; the values are not used in this one.
    `ALTER TYPE gate_reason_code ADD VALUE 'secret_in_diff' BEFORE 'other'`,
    `ALTER TYPE gate_reason_code ADD VALUE 'secret_scan_failed' BEFORE 'other'`,
  ],
  // Development only (ADR-M09). Enum values cannot be dropped: the type is created again.
  down: [
    `ALTER TYPE gate_reason_code RENAME TO gate_reason_code_0042`,
    `CREATE TYPE gate_reason_code AS ENUM ${OLD_REASON_CODES}`,
    `ALTER TABLE gate_decisions ALTER COLUMN reason_code TYPE gate_reason_code
       USING reason_code::text::gate_reason_code`,
    `DROP TYPE gate_reason_code_0042`,
  ],
});
