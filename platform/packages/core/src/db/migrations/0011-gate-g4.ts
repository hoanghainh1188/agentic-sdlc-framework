// Migration 0011: gate G4 (design/D-05 sections 5, 6.2 and 6.3, version 1.15; D-08 C06;
// design/ADR-M33; QUESTIONS #108–#110). Rules for every migration: see the header of
// 0001-tenancy.ts and design/ADR-M09.
//
// - Three G4 reason codes (QUESTIONS #110): `agent_not_runnable`, `instructions_mismatch`,
//   `autonomy_not_allowed`. The exact refusal of the agent register goes to the audit log only.
// - `intent_notices.agent_id`: a notice about an agent (the recertification warning of ADR-M31
//   §2.7) mentions the agent's owner, read when the comment is posted; never stored as a login.
// - A `blocked` intent is finished (D-03 section 6: Blocked → end), so it frees its issue and pull
//   request like a closed intent (the one-open-intent indexes of migration 0009).
import { defineMigration } from './define.js';

const OLD_REASON_CODES = `('spec_unclear', 'tests_insufficient', 'security_finding', 'out_of_scope',
  'policy_denied', 'budget_exceeded', 'ci_failed', 'ai_record_missing', 'data_class_not_allowed',
  'expired', 'input_mismatch', 'scope_mismatch', 'other')`;
const OPEN_BEFORE = `status NOT IN ('done', 'rejected', 'cancelled')`;
const OPEN = `status NOT IN ('done', 'rejected', 'cancelled', 'blocked')`;

function openIndexes(open: string): string[] {
  return [
    `DROP INDEX intents_open_issue_key`,
    `DROP INDEX intents_open_pr_key`,
    `CREATE UNIQUE INDEX intents_open_issue_key ON intents (tenant_id, project_id, issue_number)
       WHERE issue_number IS NOT NULL AND ${open}`,
    `CREATE UNIQUE INDEX intents_open_pr_key ON intents (tenant_id, project_id, pr_number)
       WHERE pr_number IS NOT NULL AND ${open}`,
  ];
}

export const migration0011GateG4 = defineMigration({
  up: [
    // PostgreSQL 12+ allows ADD VALUE in a transaction; the values are not used in this one.
    `ALTER TYPE gate_reason_code ADD VALUE 'agent_not_runnable' BEFORE 'other'`,
    `ALTER TYPE gate_reason_code ADD VALUE 'instructions_mismatch' BEFORE 'other'`,
    `ALTER TYPE gate_reason_code ADD VALUE 'autonomy_not_allowed' BEFORE 'other'`,

    `ALTER TABLE intent_notices ADD COLUMN agent_id uuid,
       ADD CONSTRAINT intent_notices_agent_fkey FOREIGN KEY (tenant_id, agent_id)
         REFERENCES agents (tenant_id, id) ON DELETE RESTRICT`,

    ...openIndexes(OPEN),
  ],
  // Development only (ADR-M09). Enum values cannot be dropped: the type is created again.
  down: [
    ...openIndexes(OPEN_BEFORE),
    `ALTER TABLE intent_notices DROP COLUMN agent_id`,
    `ALTER TYPE gate_reason_code RENAME TO gate_reason_code_0011`,
    `CREATE TYPE gate_reason_code AS ENUM ${OLD_REASON_CODES}`,
    `ALTER TABLE gate_decisions ALTER COLUMN reason_code TYPE gate_reason_code
       USING reason_code::text::gate_reason_code`,
    `DROP TYPE gate_reason_code_0011`,
  ],
});
