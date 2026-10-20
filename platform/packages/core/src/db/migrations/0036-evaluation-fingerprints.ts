// Migration 0036: evaluations as evidence for the agent register (design/D-05 sections 6.1 and
// 6.9, version 1.53; D-08 L09; design/ADR-M86 §2.1, §2.3, §2.5; QUESTIONS #501–#503). Rules for
// every migration: see the header of 0001-tenancy.ts and design/ADR-M09. Migrations 0029–0035 are
// merged and never edited.
//
// - `evaluation_configurations.source`: `agent` (the configuration named an agent of the register
//   by its key) or `model` (a model by name, with the project's default agent).
//   `allowed_tools` and `tools_sha256`: the tools the agent gets in the evaluation's runs (the
//   agent's own `allowed_tools`, QUESTIONS #501, with the register's check of migration 0008) and
//   the SHA-256 of the sorted list as JSON. Null only on
//   rows written before this migration: those never match a fingerprint.
// - `evaluations.approved_tasks_at_start`: how many tasks of the project were approved when the
//   evaluation started (QUESTIONS #503). Null only on rows written before this migration. The
//   guard trigger fixes it with the other columns.
// - `agent_approvals.evaluation_id`, `evaluation_result`: the evaluation an `activate` approval
//   named (or none) and the result code of its check (`passed`, `missing` or a refusal code of
//   ADR-M86 §2.8). Null result: the check was off, or the row is older. Codes and IDs only.
import { defineMigration } from './define.js';

const HEX64 = `~ '^[0-9a-f]{64}$'`;

const EVALUATION_FIXED = (row: 'NEW' | 'OLD', extra: string) =>
  `(${row}.id, ${row}.tenant_id, ${row}.project_id, ${row}.code, ${row}.data_class,
    ${row}.task_set_version, ${row}.config_name, ${row}.task_ids, ${row}.configuration_ids,
    ${row}.runs_per_task, ${row}.started_by, ${row}.created_at, ${row}.base_sha, ${row}.plan_id,
    ${row}.plan_version${extra.replaceAll('#', row)})`;

// The guard of migration 0035, with one more fixed column.
const evaluationsGuard = (extra: string) => `CREATE OR REPLACE FUNCTION evaluations_guard()
       RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
     BEGIN
       IF ${EVALUATION_FIXED('NEW', extra)}
          IS DISTINCT FROM
          ${EVALUATION_FIXED('OLD', extra)} THEN
         RAISE EXCEPTION 'evaluation %: only the state changes', OLD.id USING ERRCODE = 'SDA21';
       END IF;
       IF OLD.status IN ('completed', 'stopped_budget', 'cancelled', 'failed') THEN
         RAISE EXCEPTION 'evaluation %: status % is final', OLD.id, OLD.status
           USING ERRCODE = 'SDA21';
       END IF;
       IF NEW.budget_usd < OLD.budget_usd THEN
         RAISE EXCEPTION 'evaluation %: the budget only goes up', OLD.id USING ERRCODE = 'SDA21';
       END IF;
       IF OLD.status = 'running' AND NEW.status = 'queued' THEN
         RAISE EXCEPTION 'evaluation %: a running evaluation does not go back to queued', OLD.id
           USING ERRCODE = 'SDA21';
       END IF;
       RETURN NEW;
     END $$`;

const BEFORE = ', #.task_set_kind, #.task_set_commit';

export const migration0036EvaluationFingerprints = defineMigration({
  up: [
    `ALTER TABLE evaluation_configurations
       ADD COLUMN source text CHECK (source IN ('agent', 'model')),
       ADD COLUMN allowed_tools text[] CHECK (agent_tools_are_codes(allowed_tools)),
       ADD COLUMN tools_sha256 char(64) CHECK (tools_sha256 ${HEX64})`,
    `ALTER TABLE evaluation_configurations
       ADD CONSTRAINT evaluation_configurations_fingerprint CHECK (
         (source IS NULL) = (allowed_tools IS NULL)
         AND (source IS NULL) = (tools_sha256 IS NULL))`,

    `ALTER TABLE evaluations
       ADD COLUMN approved_tasks_at_start integer CHECK (approved_tasks_at_start >= 0)`,
    evaluationsGuard(`${BEFORE}, #.approved_tasks_at_start`),

    `ALTER TABLE agent_approvals
       ADD COLUMN evaluation_id uuid,
       ADD COLUMN evaluation_result text
         CHECK (evaluation_result ~ '^(passed|missing|evaluation_[a-z_]{1,48})$'),
       ADD CONSTRAINT agent_approvals_evaluation_fkey FOREIGN KEY (tenant_id, evaluation_id)
         REFERENCES evaluations (tenant_id, id) ON DELETE RESTRICT,
       ADD CONSTRAINT agent_approvals_evaluation_result CHECK (
         evaluation_id IS NULL OR evaluation_result IS NOT NULL)`,
  ],
  // Development only (ADR-M09).
  down: [
    `ALTER TABLE agent_approvals
       DROP CONSTRAINT agent_approvals_evaluation_result,
       DROP CONSTRAINT agent_approvals_evaluation_fkey,
       DROP COLUMN evaluation_result,
       DROP COLUMN evaluation_id`,
    evaluationsGuard(BEFORE),
    `ALTER TABLE evaluations DROP COLUMN approved_tasks_at_start`,
    `ALTER TABLE evaluation_configurations
       DROP CONSTRAINT evaluation_configurations_fingerprint,
       DROP COLUMN tools_sha256,
       DROP COLUMN allowed_tools,
       DROP COLUMN source`,
  ],
});
