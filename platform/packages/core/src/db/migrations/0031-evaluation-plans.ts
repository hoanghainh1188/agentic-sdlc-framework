// Migration 0031: evaluation plans (design/D-05 section 6.9, version 1.48; D-08 L05;
// design/ADR-M82 §2.1–§2.5; QUESTIONS #470–#475). Rules for every migration: see the header of
// 0001-tenancy.ts and design/ADR-M09. Migrations 0029 and 0030 are merged and never edited.
//
// - `evaluation_plans`: a plan of a project. The state changes (`active`, `paused`, `archived`;
//   archived is final), the current version only goes up, the fixed columns never change
//   (trigger SDA23). Never deleted.
// - `evaluation_plan_versions` is append-only (D-05 D3): one row per change of a plan. The
//   configurations are JSON of codes, IDs, numbers and hashes (an agent version of the register
//   or a model by name, optional prompt variant as path, commit and SHA-256); never a prompt text.
// - `evaluation_configurations` is append-only: the configurations an evaluation runs, resolved
//   when it starts (the model, the agent version, the caps, the instructions file's path, commit
//   and SHA-256). An evaluation of a plan has these rows and no `config_name`; an operator
//   evaluation of L04 has a `config_name` and no rows (QUESTIONS #475).
// - `evaluations.plan_id`, `plan_version`: the plan and the version an evaluation was started
//   from; fixed. `config_name` becomes optional: exactly one of `config_name` and `plan_id`.
//
// Errors raised by the triggers (class `SD`, mapped in errors.ts):
//   SDA23  an evaluation plan's fixed columns, an archived plan, or a version that goes down
import { defineMigration } from './define.js';

const CODE = `~ '^[a-z][a-z0-9_.-]{0,63}$'`;
const PLAN_CODE = `~ '^[a-z][a-z0-9-]{0,47}$'`;
const MODEL = `~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$'`;
const VERSION = `~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$'`;
const HEX64 = `~ '^[0-9a-f]{64}$'`;
// A repository path of an instructions file: segments of letters, digits, `.`, `_`, `-`.
const PATH = `~ '^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+){0,15}$'`;

export const migration0031EvaluationPlans = defineMigration({
  up: [
    `CREATE TABLE evaluation_plans (
       id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id        uuid NOT NULL,
       project_id       uuid NOT NULL,
       code             text NOT NULL CHECK (code ${PLAN_CODE}),
       current_version  integer NOT NULL DEFAULT 1 CHECK (current_version >= 1),
       status           text NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'paused', 'archived')),
       pause_reason     text CHECK (pause_reason ${CODE}),
       paused_until     timestamptz,
       next_run_at      timestamptz,
       seen_sha256      char(64) CHECK (seen_sha256 ${HEX64}),
       created_by       uuid,
       updated_at       timestamptz NOT NULL DEFAULT now(),
       created_at       timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT evaluation_plans_tenant_id_id_key UNIQUE (tenant_id, id),
       CONSTRAINT evaluation_plans_code_key UNIQUE (tenant_id, project_id, code),
       CONSTRAINT evaluation_plans_project_fkey FOREIGN KEY (tenant_id, project_id)
         REFERENCES projects (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT evaluation_plans_created_by_fkey FOREIGN KEY (tenant_id, created_by)
         REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT evaluation_plans_paused CHECK (
         (status = 'paused') = (pause_reason IS NOT NULL))
     )`,
    `CREATE INDEX evaluation_plans_tenant_id_project_id_idx
       ON evaluation_plans (tenant_id, project_id)`,
    // The worker's loop looks for due plans across tenants.
    `CREATE INDEX evaluation_plans_due ON evaluation_plans (next_run_at)
       WHERE status = 'active' AND next_run_at IS NOT NULL`,

    `CREATE FUNCTION evaluation_plans_guard() RETURNS trigger
       LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
     BEGIN
       IF (NEW.id, NEW.tenant_id, NEW.project_id, NEW.code, NEW.created_by, NEW.created_at)
          IS DISTINCT FROM
          (OLD.id, OLD.tenant_id, OLD.project_id, OLD.code, OLD.created_by, OLD.created_at) THEN
         RAISE EXCEPTION 'evaluation plan %: only the state changes', OLD.id
           USING ERRCODE = 'SDA23';
       END IF;
       IF OLD.status = 'archived' THEN
         RAISE EXCEPTION 'evaluation plan %: an archived plan never changes', OLD.id
           USING ERRCODE = 'SDA23';
       END IF;
       IF NEW.current_version < OLD.current_version THEN
         RAISE EXCEPTION 'evaluation plan %: the version only goes up', OLD.id
           USING ERRCODE = 'SDA23';
       END IF;
       RETURN NEW;
     END $$`,
    `CREATE TRIGGER evaluation_plans_guard BEFORE UPDATE ON evaluation_plans
       FOR EACH ROW EXECUTE FUNCTION evaluation_plans_guard()`,
    `CREATE TRIGGER evaluation_plans_no_delete BEFORE DELETE ON evaluation_plans
       FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`,
    `CREATE TRIGGER evaluation_plans_no_truncate BEFORE TRUNCATE ON evaluation_plans
       FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()`,

    `CREATE TABLE evaluation_plan_versions (
       id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
       tenant_id           uuid NOT NULL,
       plan_id             uuid NOT NULL,
       version             integer NOT NULL CHECK (version >= 1),
       data_class          data_class NOT NULL CHECK (data_class <> 'prohibited'),
       task_set_version    integer NOT NULL CHECK (task_set_version >= 1),
       task_ids            text[] CHECK (task_ids IS NULL OR evaluation_codes_ok(task_ids, 64)),
       runs_per_task       integer NOT NULL CHECK (runs_per_task BETWEEN 1 AND 20),
       budget_per_run_usd  numeric(18,6) NOT NULL CHECK (budget_per_run_usd > 0),
       monthly_cap_usd     numeric(18,6) NOT NULL CHECK (monthly_cap_usd >= budget_per_run_usd),
       trigger             text NOT NULL CHECK (trigger IN ('once', 'schedule', 'on_change')),
       schedule_every      text CHECK (schedule_every IN ('daily', 'weekly')),
       schedule_hour       integer CHECK (schedule_hour BETWEEN 0 AND 23),
       schedule_weekday    integer CHECK (schedule_weekday BETWEEN 1 AND 7),
       configurations      jsonb NOT NULL CHECK (jsonb_typeof(configurations) = 'array'
                             AND jsonb_array_length(configurations) BETWEEN 1 AND 16),
       changed_by          uuid,
       created_at          timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT evaluation_plan_versions_key UNIQUE (tenant_id, plan_id, version),
       CONSTRAINT evaluation_plan_versions_plan_fkey FOREIGN KEY (tenant_id, plan_id)
         REFERENCES evaluation_plans (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT evaluation_plan_versions_changed_by_fkey FOREIGN KEY (tenant_id, changed_by)
         REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT evaluation_plan_versions_schedule CHECK (
         (trigger = 'schedule') = (schedule_every IS NOT NULL AND schedule_hour IS NOT NULL)
         AND (schedule_weekday IS NOT NULL) = (schedule_every IS NOT DISTINCT FROM 'weekly'))
     )`,
    `CREATE TRIGGER evaluation_plan_versions_no_update_delete
       BEFORE UPDATE OR DELETE ON evaluation_plan_versions
       FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`,
    `CREATE TRIGGER evaluation_plan_versions_no_truncate BEFORE TRUNCATE ON evaluation_plan_versions
       FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()`,

    `ALTER TABLE evaluations
       ADD COLUMN plan_id uuid,
       ADD COLUMN plan_version integer CHECK (plan_version >= 1),
       ALTER COLUMN config_name DROP NOT NULL`,
    `ALTER TABLE evaluations
       ADD CONSTRAINT evaluations_plan_fkey FOREIGN KEY (tenant_id, plan_id)
         REFERENCES evaluation_plans (tenant_id, id) ON DELETE RESTRICT,
       ADD CONSTRAINT evaluations_plan_or_config CHECK (
         (plan_id IS NULL) = (plan_version IS NULL)
         AND (plan_id IS NULL) = (config_name IS NOT NULL))`,
    `CREATE INDEX evaluations_tenant_id_plan_id_idx ON evaluations (tenant_id, plan_id, created_at)
       WHERE plan_id IS NOT NULL`,
    // One open evaluation per plan (ADR-M82 §2.4).
    `CREATE UNIQUE INDEX evaluations_one_open_per_plan ON evaluations (tenant_id, plan_id)
       WHERE plan_id IS NOT NULL AND status IN ('queued', 'running')`,

    `CREATE TABLE evaluation_configurations (
       id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
       tenant_id            uuid NOT NULL,
       evaluation_id        uuid NOT NULL,
       configuration_id     text NOT NULL CHECK (configuration_id ${CODE}),
       agent_id             uuid,
       model                text NOT NULL CHECK (model ${MODEL}),
       provider_type        text NOT NULL CHECK (provider_type IN ('api', 'self_hosted')),
       agent_version        text NOT NULL CHECK (agent_version ${VERSION}),
       max_iterations       integer NOT NULL CHECK (max_iterations BETWEEN 1 AND 200),
       max_duration_min     integer NOT NULL CHECK (max_duration_min BETWEEN 1 AND 120),
       instructions_path    text CHECK (instructions_path ${PATH}),
       instructions_commit  char(40) CHECK (instructions_commit ~ '^[0-9a-f]{40}$'),
       instructions_sha256  char(64) CHECK (instructions_sha256 ${HEX64}),
       created_at           timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT evaluation_configurations_key UNIQUE (tenant_id, evaluation_id, configuration_id),
       CONSTRAINT evaluation_configurations_evaluation_fkey FOREIGN KEY (tenant_id, evaluation_id)
         REFERENCES evaluations (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT evaluation_configurations_agent_fkey FOREIGN KEY (tenant_id, agent_id)
         REFERENCES agents (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT evaluation_configurations_instructions CHECK (
         (instructions_path IS NULL) = (instructions_commit IS NULL)
         AND (instructions_path IS NULL) = (instructions_sha256 IS NULL))
     )`,
    `CREATE TRIGGER evaluation_configurations_no_update_delete
       BEFORE UPDATE OR DELETE ON evaluation_configurations
       FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`,
    `CREATE TRIGGER evaluation_configurations_no_truncate
       BEFORE TRUNCATE ON evaluation_configurations
       FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()`,

    // The fixed columns of an evaluation now include its plan.
    `CREATE OR REPLACE FUNCTION evaluations_guard() RETURNS trigger
       LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
     BEGIN
       IF (NEW.id, NEW.tenant_id, NEW.project_id, NEW.code, NEW.data_class, NEW.task_set_version,
           NEW.config_name, NEW.task_ids, NEW.configuration_ids, NEW.runs_per_task,
           NEW.started_by, NEW.created_at, NEW.base_sha, NEW.plan_id, NEW.plan_version)
          IS DISTINCT FROM
          (OLD.id, OLD.tenant_id, OLD.project_id, OLD.code, OLD.data_class, OLD.task_set_version,
           OLD.config_name, OLD.task_ids, OLD.configuration_ids, OLD.runs_per_task,
           OLD.started_by, OLD.created_at, OLD.base_sha, OLD.plan_id, OLD.plan_version) THEN
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
     END $$`,

    `REVOKE ALL ON evaluation_plans, evaluation_plan_versions, evaluation_configurations
       FROM PUBLIC`,
    `GRANT SELECT, INSERT ON evaluation_plans, evaluation_plan_versions, evaluation_configurations
       TO platform_app`,
    `GRANT UPDATE (current_version, status, pause_reason, paused_until, next_run_at, seen_sha256,
                   updated_at) ON evaluation_plans TO platform_app`,
  ],
  // Development only (ADR-M09).
  down: [
    // The guard of 0030 again, before its new columns go.
    `CREATE OR REPLACE FUNCTION evaluations_guard() RETURNS trigger
       LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
     BEGIN
       IF (NEW.id, NEW.tenant_id, NEW.project_id, NEW.code, NEW.data_class, NEW.task_set_version,
           NEW.config_name, NEW.task_ids, NEW.configuration_ids, NEW.runs_per_task,
           NEW.started_by, NEW.created_at, NEW.base_sha)
          IS DISTINCT FROM
          (OLD.id, OLD.tenant_id, OLD.project_id, OLD.code, OLD.data_class, OLD.task_set_version,
           OLD.config_name, OLD.task_ids, OLD.configuration_ids, OLD.runs_per_task,
           OLD.started_by, OLD.created_at, OLD.base_sha) THEN
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
     END $$`,
    `DROP TABLE evaluation_configurations`,
    `DROP INDEX evaluations_one_open_per_plan`,
    `DROP INDEX evaluations_tenant_id_plan_id_idx`,
    `ALTER TABLE evaluations DROP CONSTRAINT evaluations_plan_or_config`,
    `ALTER TABLE evaluations DROP CONSTRAINT evaluations_plan_fkey`,
    `ALTER TABLE evaluations DROP COLUMN plan_version, DROP COLUMN plan_id`,
    `ALTER TABLE evaluations ALTER COLUMN config_name SET NOT NULL`,
    `DROP TABLE evaluation_plan_versions`,
    `DROP TABLE evaluation_plans`,
    `DROP FUNCTION evaluation_plans_guard()`,
  ],
});
