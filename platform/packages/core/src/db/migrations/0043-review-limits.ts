// Migration 0043: the G5 review limits (design/D-05 section 5, version 1.64; D-08 H05; design/ADR-M95
// §2.4; QUESTIONS #456, #601–#604). Rules for every migration: see the header of 0001-tenancy.ts and
// design/ADR-M09. Migrations 0001–0042 are merged and never edited.
//
// - Two G5 reason codes for the waiting cause and the split: `review_too_large` (the run's change
//   is over `run.review_limits`) and `review_size_unknown` (the runner recorded no size).
// - Three reason codes a person gives to allow such a change: `generated_change`,
//   `mechanical_change`, `cannot_split`.
// - The run event `diff_measured` needs no change: its values (a code and counts) already pass
//   `run_event_payload_is_coded`.
import { defineMigration } from './define.js';

const OLD_REASON_CODES = `('spec_unclear', 'tests_insufficient', 'security_finding', 'out_of_scope',
  'policy_denied', 'budget_exceeded', 'ci_failed', 'ai_record_missing', 'data_class_not_allowed',
  'expired', 'input_mismatch', 'scope_mismatch', 'agent_not_runnable', 'instructions_mismatch',
  'autonomy_not_allowed', 'instructions_unpinned', 'run_cap_reached', 'merged_before_approval',
  'tool_not_runnable', 'secret_in_diff', 'secret_scan_failed', 'other')`;

export const migration0043ReviewLimits = defineMigration({
  up: [
    // PostgreSQL 12+ allows ADD VALUE in a transaction; the values are not used in this one.
    `ALTER TYPE gate_reason_code ADD VALUE 'review_too_large' BEFORE 'other'`,
    `ALTER TYPE gate_reason_code ADD VALUE 'review_size_unknown' BEFORE 'other'`,
    `ALTER TYPE gate_reason_code ADD VALUE 'generated_change' BEFORE 'other'`,
    `ALTER TYPE gate_reason_code ADD VALUE 'mechanical_change' BEFORE 'other'`,
    `ALTER TYPE gate_reason_code ADD VALUE 'cannot_split' BEFORE 'other'`,
  ],
  // Development only (ADR-M09). Enum values cannot be dropped: the type is created again.
  down: [
    `ALTER TYPE gate_reason_code RENAME TO gate_reason_code_0043`,
    `CREATE TYPE gate_reason_code AS ENUM ${OLD_REASON_CODES}`,
    `ALTER TABLE gate_decisions ALTER COLUMN reason_code TYPE gate_reason_code
       USING reason_code::text::gate_reason_code`,
    `DROP TYPE gate_reason_code_0043`,
  ],
});
