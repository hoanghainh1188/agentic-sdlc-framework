// Migration 0035: evaluations on a project's own task set (design/D-05 section 6.10, version 1.52;
// D-08 L07; design/ADR-M85 §2.9, §2.10; QUESTIONS #490, #491). Rules for every migration: see the
// header of 0001-tenancy.ts and design/ADR-M09. Migrations 0029–0034 are merged and never edited.
//
// - `evaluations.task_set_kind`: `folder` (a numbered task set: v1 or the server's own set) or
//   `project` (the project's approved tasks, ADR-M85). `task_set_version` is the number of a
//   `folder` set only; `task_set_commit` is the default branch's commit the cards of a `project`
//   set were read from. A `project` evaluation has no `base_sha`: each run has its own.
// - `evaluation_plan_versions.task_set_kind`: the same kind; a `project` plan has no version and no
//   commit (each of its evaluations reads the commit when it starts, QUESTIONS #491).
// - `evaluation_runs.base_sha`: the base commit of the run's task (`project` sets only).
// - The guard triggers now also fix the new columns. Codes, commits and hashes only.
import { defineMigration } from './define.js';

const SHA = `~ '^[0-9a-f]{40}$'`;

const EVALUATION_FIXED = (row: 'NEW' | 'OLD', extra: string) =>
  `(${row}.id, ${row}.tenant_id, ${row}.project_id, ${row}.code, ${row}.data_class,
    ${row}.task_set_version, ${row}.config_name, ${row}.task_ids, ${row}.configuration_ids,
    ${row}.runs_per_task, ${row}.started_by, ${row}.created_at, ${row}.base_sha, ${row}.plan_id,
    ${row}.plan_version${extra.replaceAll('#', row)})`;

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

const RUN_FIXED = (row: 'NEW' | 'OLD', extra: string) =>
  `(${row}.id, ${row}.tenant_id, ${row}.evaluation_id, ${row}.configuration_id, ${row}.task_id,
    ${row}.run_index, ${row}.model, ${row}.provider_type, ${row}.agent_version, ${row}.created_at,
    ${row}.max_iterations, ${row}.max_duration_min${extra.replaceAll('#', row)})`;

const runsGuard = (extra: string) => `CREATE OR REPLACE FUNCTION evaluation_runs_guard()
       RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
     BEGIN
       IF ${RUN_FIXED('NEW', extra)}
          IS DISTINCT FROM
          ${RUN_FIXED('OLD', extra)} THEN
         RAISE EXCEPTION 'evaluation run %: only the state changes', OLD.id
           USING ERRCODE = 'SDA22';
       END IF;
       IF OLD.status IN ('scored', 'failed', 'cancelled') THEN
         RAISE EXCEPTION 'evaluation run %: status % is final', OLD.id, OLD.status
           USING ERRCODE = 'SDA22';
       END IF;
       IF NEW.attempt < OLD.attempt THEN
         RAISE EXCEPTION 'evaluation run %: attempts only grow', OLD.id USING ERRCODE = 'SDA22';
       END IF;
       IF NOT (
         NEW.status = OLD.status
         OR (OLD.status = 'queued' AND NEW.status IN ('running', 'cancelled'))
         OR (OLD.status = 'running' AND NEW.status IN ('scored', 'failed', 'cancelled', 'preempted'))
         OR (OLD.status = 'preempted' AND NEW.status IN ('queued', 'cancelled'))
       ) THEN
         RAISE EXCEPTION 'evaluation run %: % to % is not allowed', OLD.id, OLD.status, NEW.status
           USING ERRCODE = 'SDA22';
       END IF;
       IF OLD.status = 'preempted' AND NEW.status = 'queued' AND NEW.attempt <= OLD.attempt THEN
         RAISE EXCEPTION 'evaluation run %: a queued-again run needs the next attempt', OLD.id
           USING ERRCODE = 'SDA22';
       END IF;
       RETURN NEW;
     END $$`;

export const migration0035ProjectTaskSets = defineMigration({
  up: [
    `ALTER TABLE evaluations
       ADD COLUMN task_set_kind text NOT NULL DEFAULT 'folder'
         CHECK (task_set_kind IN ('folder', 'project')),
       ADD COLUMN task_set_commit char(40) CHECK (task_set_commit ${SHA}),
       ALTER COLUMN task_set_version DROP NOT NULL`,
    `ALTER TABLE evaluations
       ADD CONSTRAINT evaluations_task_set CHECK (
         (task_set_kind = 'folder') = (task_set_version IS NOT NULL)
         AND (task_set_kind = 'project') = (task_set_commit IS NOT NULL)
         AND (task_set_kind = 'folder' OR base_sha IS NULL))`,
    evaluationsGuard(', #.task_set_kind, #.task_set_commit'),

    `ALTER TABLE evaluation_plan_versions
       ADD COLUMN task_set_kind text NOT NULL DEFAULT 'folder'
         CHECK (task_set_kind IN ('folder', 'project')),
       ALTER COLUMN task_set_version DROP NOT NULL`,
    `ALTER TABLE evaluation_plan_versions
       ADD CONSTRAINT evaluation_plan_versions_task_set CHECK (
         (task_set_kind = 'folder') = (task_set_version IS NOT NULL))`,

    `ALTER TABLE evaluation_runs ADD COLUMN base_sha char(40) CHECK (base_sha ${SHA})`,
    runsGuard(', #.base_sha'),
  ],
  // Development only (ADR-M09): fails while an evaluation or plan of a project's task set exists.
  down: [
    runsGuard(''),
    `ALTER TABLE evaluation_runs DROP COLUMN base_sha`,
    `ALTER TABLE evaluation_plan_versions DROP CONSTRAINT evaluation_plan_versions_task_set`,
    `ALTER TABLE evaluation_plan_versions
       ALTER COLUMN task_set_version SET NOT NULL,
       DROP COLUMN task_set_kind`,
    evaluationsGuard(''),
    `ALTER TABLE evaluations DROP CONSTRAINT evaluations_task_set`,
    `ALTER TABLE evaluations
       ALTER COLUMN task_set_version SET NOT NULL,
       DROP COLUMN task_set_commit,
       DROP COLUMN task_set_kind`,
  ],
});
