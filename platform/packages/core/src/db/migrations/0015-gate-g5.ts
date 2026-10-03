// Migration 0015: gate G5 in the workflow (design/D-05 sections 5 and 6.2, version 1.19; D-08 C07
// PR 2; design/ADR-M34 §2.8–§2.9; QUESTIONS #21, #131–#134). Rules for every migration: see the
// header of 0001-tenancy.ts and design/ADR-M09.
//
// - One G5 reason code: `run_cap_reached` (the iteration cap, the time cap or a stalled run; the
//   exact cause goes to the audit event `gate.g5_check_failed`). The cost cap stays
//   `budget_exceeded`; the scope `out_of_scope`.
// - `intents.run_budget_usd`: the run budget of the intent's next runs after a `resume` with a
//   budget increase (QUESTIONS #133: previous cap + X). Null: the project's `budget.default_run_usd`.
// - The budgets of an intent only go up: `budget_usd` never decreases, `run_budget_usd` never
//   decreases and never goes back to null (QUESTIONS #133). `platform_app` may now update both.
//
// Custom SQLSTATE (translated in errors.ts):
//   SDA12  an intent budget that would go down
import { defineMigration } from './define.js';

const OLD_REASON_CODES = `('spec_unclear', 'tests_insufficient', 'security_finding', 'out_of_scope',
  'policy_denied', 'budget_exceeded', 'ci_failed', 'ai_record_missing', 'data_class_not_allowed',
  'expired', 'input_mismatch', 'scope_mismatch', 'agent_not_runnable', 'instructions_mismatch',
  'autonomy_not_allowed', 'instructions_unpinned', 'other')`;

export const migration0015GateG5 = defineMigration({
  up: [
    // PostgreSQL 12+ allows ADD VALUE in a transaction; the value is not used in this one.
    `ALTER TYPE gate_reason_code ADD VALUE 'run_cap_reached' BEFORE 'other'`,

    `ALTER TABLE intents ADD COLUMN run_budget_usd numeric(18,6)
       CHECK (run_budget_usd IS NULL OR run_budget_usd > 0)`,
    `CREATE FUNCTION intents_budget_only_up() RETURNS trigger
       LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.budget_usd < OLD.budget_usd
            OR (OLD.run_budget_usd IS NOT NULL
                AND (NEW.run_budget_usd IS NULL OR NEW.run_budget_usd < OLD.run_budget_usd)) THEN
           RAISE EXCEPTION 'intents: the budget of intent % only goes up', OLD.id
             USING ERRCODE = 'SDA12';
         END IF;
         RETURN NEW;
       END $$`,
    `CREATE TRIGGER intents_budget_only_up BEFORE UPDATE OF budget_usd, run_budget_usd ON intents
       FOR EACH ROW EXECUTE FUNCTION intents_budget_only_up()`,
    `GRANT UPDATE (budget_usd, run_budget_usd) ON intents TO platform_app`,
  ],
  // Development only (ADR-M09). Enum values cannot be dropped: the type is created again.
  down: [
    `REVOKE UPDATE (budget_usd, run_budget_usd) ON intents FROM platform_app`,
    `DROP TRIGGER intents_budget_only_up ON intents`,
    `DROP FUNCTION intents_budget_only_up()`,
    `ALTER TABLE intents DROP COLUMN run_budget_usd`,
    `ALTER TYPE gate_reason_code RENAME TO gate_reason_code_0015`,
    `CREATE TYPE gate_reason_code AS ENUM ${OLD_REASON_CODES}`,
    `ALTER TABLE gate_decisions ALTER COLUMN reason_code TYPE gate_reason_code
       USING reason_code::text::gate_reason_code`,
    `DROP TYPE gate_reason_code_0015`,
  ],
});
