// Migration 0013: the runner's part of gate G5 and the G4 instruction-file check (design/D-05
// sections 5 and 6.4, version 1.18; D-08 C07 PR 1; design/ADR-M34; QUESTIONS #126). Rules for
// every migration: see the header of 0001-tenancy.ts and design/ADR-M09.
//
// - One G4 reason code (QUESTIONS #126): `instructions_unpinned`, an agent instruction file the
//   register does not pin exists at the base commit, or the platform cannot list the commit's
//   files to prove there is none. The exact cause (`instructions_unpinned`, `tree_truncated`) goes
//   to the audit event `gate.g4_check_failed` only.
// - The run events of C07 (`key_issued`, `budget_warning`, `diff_stored`, `changes_checked`) need
//   no change: event types and coded values already pass `run_event_payload_is_coded`, and a
//   decimal amount (`0.5`) is a coded string there. The evidence kind `diff` exists since 0012.
import { defineMigration } from './define.js';

const OLD_REASON_CODES = `('spec_unclear', 'tests_insufficient', 'security_finding', 'out_of_scope',
  'policy_denied', 'budget_exceeded', 'ci_failed', 'ai_record_missing', 'data_class_not_allowed',
  'expired', 'input_mismatch', 'scope_mismatch', 'agent_not_runnable', 'instructions_mismatch',
  'autonomy_not_allowed', 'other')`;

export const migration0013GateG5Runner = defineMigration({
  up: [
    // PostgreSQL 12+ allows ADD VALUE in a transaction; the value is not used in this one.
    `ALTER TYPE gate_reason_code ADD VALUE 'instructions_unpinned' BEFORE 'other'`,
  ],
  // Development only (ADR-M09). Enum values cannot be dropped: the type is created again.
  down: [
    `ALTER TYPE gate_reason_code RENAME TO gate_reason_code_0013`,
    `CREATE TYPE gate_reason_code AS ENUM ${OLD_REASON_CODES}`,
    `ALTER TABLE gate_decisions ALTER COLUMN reason_code TYPE gate_reason_code
       USING reason_code::text::gate_reason_code`,
    `DROP TYPE gate_reason_code_0013`,
  ],
});
