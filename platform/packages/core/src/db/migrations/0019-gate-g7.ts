// Migration 0019: gate G7, review and merge (design/D-05 section 5, version 1.26; D-08 E01;
// design/ADR-M41; QUESTIONS #175–#179). Rules for every migration: see the header of
// 0001-tenancy.ts and design/ADR-M09.
//
// One G7 reason code: `merged_before_approval` (the pull request was merged before G7 passed, or
// by a bot or a producer of the change; QUESTIONS #177). A dismissed or replaced review, and an
// approval of an older head, are voided with the existing `input_mismatch`.
import { defineMigration } from './define.js';

const OLD_REASON_CODES = `('spec_unclear', 'tests_insufficient', 'security_finding', 'out_of_scope',
  'policy_denied', 'budget_exceeded', 'ci_failed', 'ai_record_missing', 'data_class_not_allowed',
  'expired', 'input_mismatch', 'scope_mismatch', 'agent_not_runnable', 'instructions_mismatch',
  'autonomy_not_allowed', 'instructions_unpinned', 'run_cap_reached', 'other')`;

export const migration0019GateG7 = defineMigration({
  up: [
    // PostgreSQL 12+ allows ADD VALUE in a transaction; the value is not used in this one.
    `ALTER TYPE gate_reason_code ADD VALUE 'merged_before_approval' BEFORE 'other'`,
  ],
  // Development only (ADR-M09). Enum values cannot be dropped: the type is created again.
  down: [
    `ALTER TYPE gate_reason_code RENAME TO gate_reason_code_0019`,
    `CREATE TYPE gate_reason_code AS ENUM ${OLD_REASON_CODES}`,
    `ALTER TABLE gate_decisions ALTER COLUMN reason_code TYPE gate_reason_code
       USING reason_code::text::gate_reason_code`,
    `DROP TYPE gate_reason_code_0019`,
  ],
});
