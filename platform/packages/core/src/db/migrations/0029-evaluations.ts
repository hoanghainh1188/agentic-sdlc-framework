// Migration 0029: evaluations on the server (design/D-05 section 6.8, version 1.44; D-08 L04;
// design/ADR-M81 §2.2, §2.4; QUESTIONS #460, #462). Rules for every migration: see the header of
// 0001-tenancy.ts and design/ADR-M09.
//
// - Evaluation runs live in their own tables, never in `runs` (QUESTIONS #460), so the metrics of
//   V13, the gates, the kill switch and the cost report stay unmixed.
// - `evaluations`: one evaluation (a project, a task set version, the task and configuration
//   codes, the runs per task, a budget). The status moves forward; the budget only goes up
//   (trigger SDA21).
// - `evaluation_runs`: one run of one task for one configuration. `preempted` is the state of a
//   run stopped to give its slot to a real run (QUESTIONS #461); it goes back to `queued` with the
//   next `attempt`. Scored, failed and cancelled runs never change (trigger SDA22).
// - `evaluation_run_results` is append-only (D-05 D3) and holds the numbers and codes of
//   ADR-M78 §2.4 and the hardware block of ADR-M81 §2.1. Never a prompt, task text, code or diff.
// - `cost_records.evaluation_run_id` (QUESTIONS #462): the cost of an evaluation run. A record
//   belongs to an intent or to an evaluation run, never both. The table stays append-only.
// - Every text column is a code or a short machine name with a format CHECK, never free text.
//
// Errors raised by the triggers (class `SD`, mapped in errors.ts):
//   SDA21  an evaluation's fixed columns, a final status, or a budget that would go down
//   SDA22  an evaluation run's fixed columns, a final status, or a move that is not allowed
import { defineMigration } from './define.js';

const CODE = `~ '^[a-z][a-z0-9_.-]{0,63}$'`;
const MODEL = `~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$'`;
const VERSION = `~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$'`;
// A machine name such as `Apple M4 Pro` or `AMD EPYC 9354 (32 cores)`.
const MACHINE = `~ '^[A-Za-z0-9][A-Za-z0-9 ._:@()/+-]{0,127}$'`;
const HEX64 = `~ '^[0-9a-f]{64}$'`;

const EVALUATION_FINAL = `'completed', 'stopped_budget', 'cancelled', 'failed'`;
const RUN_FINAL = `'scored', 'failed', 'cancelled'`;

export const migration0029Evaluations = defineMigration({
  up: [
    // A list of codes: 1 to `max` entries, each a code (task and configuration IDs).
    `CREATE FUNCTION evaluation_codes_ok(codes text[], max_items integer) RETURNS boolean
       LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
       SELECT codes IS NOT NULL
         AND cardinality(codes) BETWEEN 1 AND max_items
         AND NOT EXISTS (SELECT 1 FROM unnest(codes) AS c(code) WHERE c.code IS NULL
                          OR c.code !~ '^[a-z][a-z0-9_.-]{0,63}$')
     $$`,

    `CREATE TABLE evaluations (
       id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id         uuid NOT NULL,
       project_id        uuid NOT NULL,
       code              text NOT NULL CHECK (code ~ '^EVAL-[0-9]{4}-[0-9]{4,9}$'),
       data_class        data_class NOT NULL CHECK (data_class <> 'prohibited'),
       task_set_version  integer NOT NULL CHECK (task_set_version >= 1),
       config_name       text NOT NULL CHECK (config_name ${CODE}),
       task_ids          text[] NOT NULL CHECK (evaluation_codes_ok(task_ids, 64)),
       configuration_ids text[] NOT NULL CHECK (evaluation_codes_ok(configuration_ids, 16)),
       runs_per_task     integer NOT NULL CHECK (runs_per_task BETWEEN 1 AND 50),
       budget_usd        numeric(18,6) NOT NULL CHECK (budget_usd > 0),
       status            text NOT NULL DEFAULT 'queued' CHECK (status IN
                           ('queued', 'running', ${EVALUATION_FINAL})),
       stop_reason       text CHECK (stop_reason ${CODE}),
       started_by        uuid,
       finished_at       timestamptz,
       updated_at        timestamptz NOT NULL DEFAULT now(),
       created_at        timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT evaluations_tenant_id_id_key UNIQUE (tenant_id, id),
       CONSTRAINT evaluations_tenant_id_code_key UNIQUE (tenant_id, code),
       CONSTRAINT evaluations_project_fkey FOREIGN KEY (tenant_id, project_id)
         REFERENCES projects (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT evaluations_started_by_fkey FOREIGN KEY (tenant_id, started_by)
         REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT evaluations_finished CHECK (
         (finished_at IS NOT NULL) = (status IN (${EVALUATION_FINAL})))
     )`,
    `CREATE INDEX evaluations_tenant_id_status_idx ON evaluations (tenant_id, status)`,
    `CREATE INDEX evaluations_tenant_id_project_id_idx
       ON evaluations (tenant_id, project_id, created_at)`,

    `CREATE FUNCTION evaluations_guard() RETURNS trigger
       LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
     BEGIN
       IF (NEW.id, NEW.tenant_id, NEW.project_id, NEW.code, NEW.data_class, NEW.task_set_version,
           NEW.config_name, NEW.task_ids, NEW.configuration_ids, NEW.runs_per_task,
           NEW.started_by, NEW.created_at)
          IS DISTINCT FROM
          (OLD.id, OLD.tenant_id, OLD.project_id, OLD.code, OLD.data_class, OLD.task_set_version,
           OLD.config_name, OLD.task_ids, OLD.configuration_ids, OLD.runs_per_task,
           OLD.started_by, OLD.created_at) THEN
         RAISE EXCEPTION 'evaluation %: only the state changes', OLD.id USING ERRCODE = 'SDA21';
       END IF;
       IF OLD.status IN (${EVALUATION_FINAL}) THEN
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
    `CREATE TRIGGER evaluations_guard BEFORE UPDATE ON evaluations
       FOR EACH ROW EXECUTE FUNCTION evaluations_guard()`,
    `CREATE TRIGGER evaluations_no_delete BEFORE DELETE ON evaluations
       FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`,
    `CREATE TRIGGER evaluations_no_truncate BEFORE TRUNCATE ON evaluations
       FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()`,

    `CREATE TABLE evaluation_runs (
       id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id        uuid NOT NULL,
       evaluation_id    uuid NOT NULL,
       configuration_id text NOT NULL CHECK (configuration_id ${CODE}),
       task_id          text NOT NULL CHECK (task_id ${CODE}),
       run_index        integer NOT NULL CHECK (run_index BETWEEN 1 AND 50),
       model            text NOT NULL CHECK (model ${MODEL}),
       provider_type    text NOT NULL CHECK (provider_type IN ('api', 'self_hosted')),
       agent_version    text NOT NULL CHECK (agent_version ${VERSION}),
       attempt          integer NOT NULL DEFAULT 1 CHECK (attempt >= 1),
       status           text NOT NULL DEFAULT 'queued' CHECK (status IN
                          ('queued', 'running', 'preempted', ${RUN_FINAL})),
       stop_reason      text CHECK (stop_reason ${CODE}),
       runner_instance  text CHECK (runner_instance ${CODE}),
       started_at       timestamptz,
       finished_at      timestamptz,
       updated_at       timestamptz NOT NULL DEFAULT now(),
       created_at       timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT evaluation_runs_tenant_id_id_key UNIQUE (tenant_id, id),
       CONSTRAINT evaluation_runs_cell_key
         UNIQUE (tenant_id, evaluation_id, configuration_id, task_id, run_index),
       CONSTRAINT evaluation_runs_evaluation_fkey FOREIGN KEY (tenant_id, evaluation_id)
         REFERENCES evaluations (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT evaluation_runs_finished CHECK (
         (finished_at IS NOT NULL) = (status IN (${RUN_FINAL}))),
       CONSTRAINT evaluation_runs_finished_after_start CHECK (
         finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at)
     )`,
    `CREATE INDEX evaluation_runs_tenant_id_evaluation_id_status_idx
       ON evaluation_runs (tenant_id, evaluation_id, status)`,
    // The runner and the loop look for queued work across evaluations.
    `CREATE INDEX evaluation_runs_queued ON evaluation_runs (tenant_id, created_at)
       WHERE status = 'queued'`,

    `CREATE FUNCTION evaluation_runs_guard() RETURNS trigger
       LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
     BEGIN
       IF (NEW.id, NEW.tenant_id, NEW.evaluation_id, NEW.configuration_id, NEW.task_id,
           NEW.run_index, NEW.model, NEW.provider_type, NEW.agent_version, NEW.created_at)
          IS DISTINCT FROM
          (OLD.id, OLD.tenant_id, OLD.evaluation_id, OLD.configuration_id, OLD.task_id,
           OLD.run_index, OLD.model, OLD.provider_type, OLD.agent_version, OLD.created_at) THEN
         RAISE EXCEPTION 'evaluation run %: only the state changes', OLD.id
           USING ERRCODE = 'SDA22';
       END IF;
       IF OLD.status IN (${RUN_FINAL}) THEN
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
       -- A preempted run is queued again with the next attempt, never the same one.
       IF OLD.status = 'preempted' AND NEW.status = 'queued' AND NEW.attempt <= OLD.attempt THEN
         RAISE EXCEPTION 'evaluation run %: a queued-again run needs the next attempt', OLD.id
           USING ERRCODE = 'SDA22';
       END IF;
       RETURN NEW;
     END $$`,
    `CREATE TRIGGER evaluation_runs_guard BEFORE UPDATE ON evaluation_runs
       FOR EACH ROW EXECUTE FUNCTION evaluation_runs_guard()`,
    `CREATE TRIGGER evaluation_runs_no_delete BEFORE DELETE ON evaluation_runs
       FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`,
    `CREATE TRIGGER evaluation_runs_no_truncate BEFORE TRUNCATE ON evaluation_runs
       FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()`,

    `CREATE TABLE evaluation_run_results (
       id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
       tenant_id           uuid NOT NULL,
       evaluation_run_id   uuid NOT NULL,
       attempt             integer NOT NULL CHECK (attempt >= 1),
       instructions_sha256 char(64) NOT NULL CHECK (instructions_sha256 ${HEX64}),
       outcome             text NOT NULL CHECK (outcome ${CODE}),
       status              text NOT NULL CHECK (status ${CODE}),
       stop_reason         text CHECK (stop_reason ${CODE}),
       applied             boolean NOT NULL,
       resolved            boolean NOT NULL,
       fail_to_pass_passed boolean NOT NULL,
       pass_to_pass_passed boolean NOT NULL,
       ci_passed           boolean NOT NULL,
       scope_breach        boolean NOT NULL,
       out_of_plan_files   integer NOT NULL CHECK (out_of_plan_files >= 0),
       lint_findings       integer NOT NULL CHECK (lint_findings >= 0),
       diff_files          integer NOT NULL CHECK (diff_files >= 0),
       diff_lines_added    integer NOT NULL CHECK (diff_lines_added >= 0),
       diff_lines_removed  integer NOT NULL CHECK (diff_lines_removed >= 0),
       seconds             integer NOT NULL CHECK (seconds >= 0),
       iterations          integer NOT NULL CHECK (iterations >= 0),
       model_calls         integer NOT NULL CHECK (model_calls >= 0),
       input_tokens        bigint NOT NULL CHECK (input_tokens >= 0),
       output_tokens       bigint NOT NULL CHECK (output_tokens >= 0),
       cached_input_tokens bigint NOT NULL CHECK (cached_input_tokens >= 0),
       cost_usd            numeric(18,6) NOT NULL CHECK (cost_usd >= 0),
       hw_cpu_model        text NOT NULL CHECK (hw_cpu_model ${MACHINE}),
       hw_cpu_cores        integer NOT NULL CHECK (hw_cpu_cores >= 0),
       hw_memory_gb        integer NOT NULL CHECK (hw_memory_gb >= 0),
       hw_docker_version   text NOT NULL CHECK (hw_docker_version ${VERSION}),
       hw_gpu              text CHECK (hw_gpu ${MACHINE}),
       hw_runner_instance  text CHECK (hw_runner_instance ${CODE}),
       created_at          timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT evaluation_run_results_one_per_run UNIQUE (tenant_id, evaluation_run_id),
       CONSTRAINT evaluation_run_results_run_fkey FOREIGN KEY (tenant_id, evaluation_run_id)
         REFERENCES evaluation_runs (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT evaluation_run_results_resolved CHECK (
         NOT resolved OR (applied AND fail_to_pass_passed AND pass_to_pass_passed)),
       CONSTRAINT evaluation_run_results_cached CHECK (cached_input_tokens <= input_tokens)
     )`,
    `CREATE TRIGGER evaluation_run_results_no_update_delete
       BEFORE UPDATE OR DELETE ON evaluation_run_results
       FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`,
    `CREATE TRIGGER evaluation_run_results_no_truncate BEFORE TRUNCATE ON evaluation_run_results
       FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()`,

    // The cost of an evaluation run (QUESTIONS #462): never an intent's, never a real run's.
    `ALTER TABLE cost_records ADD COLUMN evaluation_run_id uuid`,
    `ALTER TABLE cost_records
       ADD CONSTRAINT cost_records_evaluation_run_fkey FOREIGN KEY (tenant_id, evaluation_run_id)
         REFERENCES evaluation_runs (tenant_id, id) ON DELETE RESTRICT`,
    `ALTER TABLE cost_records
       ADD CONSTRAINT cost_records_evaluation_run_exclusive CHECK (
         evaluation_run_id IS NULL OR (intent_id IS NULL AND run_id IS NULL))`,
    `CREATE INDEX cost_records_tenant_id_evaluation_run_id_idx
       ON cost_records (tenant_id, evaluation_run_id) WHERE evaluation_run_id IS NOT NULL`,

    `REVOKE ALL ON evaluations, evaluation_runs, evaluation_run_results FROM PUBLIC`,
    `GRANT SELECT, INSERT ON evaluations, evaluation_runs, evaluation_run_results
       TO platform_app`,
    `GRANT UPDATE (status, stop_reason, budget_usd, finished_at, updated_at) ON evaluations
       TO platform_app`,
    `GRANT UPDATE (status, stop_reason, attempt, runner_instance, started_at, finished_at,
                   updated_at) ON evaluation_runs TO platform_app`,
  ],
  // Development only (ADR-M09).
  down: [
    `DROP INDEX cost_records_tenant_id_evaluation_run_id_idx`,
    `ALTER TABLE cost_records DROP CONSTRAINT cost_records_evaluation_run_exclusive`,
    `ALTER TABLE cost_records DROP CONSTRAINT cost_records_evaluation_run_fkey`,
    `ALTER TABLE cost_records DROP COLUMN evaluation_run_id`,
    `DROP TABLE evaluation_run_results`,
    `DROP TABLE evaluation_runs`,
    `DROP FUNCTION evaluation_runs_guard()`,
    `DROP TABLE evaluations`,
    `DROP FUNCTION evaluations_guard()`,
    `DROP FUNCTION evaluation_codes_ok(text[], integer)`,
  ],
});
