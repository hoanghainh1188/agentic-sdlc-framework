// Migration 0044: agent dependency checks (task H02; design/ADR-M96 §2.4; QUESTIONS #606–#608).
// Rules for every migration: see the header of 0001-tenancy.ts and design/ADR-M09.
// Migrations 0001–0043 are merged and never edited.
//
// - Two G6 reason codes:
//   - `dependency_finding`: unapproved license, install scripts, or typosquatting warning found
//   - `dependency_scan_failed`: scanning dependencies failed
import { defineMigration } from './define.js';

const OLD_REASON_CODES = `('spec_unclear', 'tests_insufficient', 'security_finding', 'out_of_scope',
  'policy_denied', 'budget_exceeded', 'ci_failed', 'ai_record_missing', 'data_class_not_allowed',
  'expired', 'input_mismatch', 'scope_mismatch', 'agent_not_runnable', 'instructions_mismatch',
  'autonomy_not_allowed', 'instructions_unpinned', 'run_cap_reached', 'merged_before_approval',
  'tool_not_runnable', 'secret_in_diff', 'secret_scan_failed', 'review_too_large', 'review_size_unknown',
  'generated_change', 'mechanical_change', 'cannot_split', 'other')`;

export const migration0044DependencyChecks = defineMigration({
  up: [
    // PostgreSQL 12+ allows ADD VALUE in a transaction; the values are not used in this one.
    `ALTER TYPE gate_reason_code ADD VALUE 'dependency_finding' BEFORE 'other'`,
    `ALTER TYPE gate_reason_code ADD VALUE 'dependency_scan_failed' BEFORE 'other'`,
  ],
  // Development only (ADR-M09). Enum values cannot be dropped: the type is created again.
  down: [
    `ALTER TYPE gate_reason_code RENAME TO gate_reason_code_0044`,
    `CREATE TYPE gate_reason_code AS ENUM ${OLD_REASON_CODES}`,
    `ALTER TABLE gate_decisions ALTER COLUMN reason_code TYPE gate_reason_code
       USING reason_code::text::gate_reason_code`,
    `DROP TYPE gate_reason_code_0044`,
  ],
});
