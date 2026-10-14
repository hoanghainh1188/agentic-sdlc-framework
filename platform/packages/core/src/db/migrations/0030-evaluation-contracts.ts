// Migration 0030: the contract of an evaluation run (design/D-05 section 6.8, version 1.46; D-08
// L04; design/ADR-M81 §2.2; QUESTIONS #460). Rules for every migration: see the header of
// 0001-tenancy.ts and design/ADR-M09. Migration 0029 is merged and never edited.
//
// - `evaluation_run_contracts`: the signed contract of one attempt of an evaluation run (kind
//   `evaluation`, same Transit key as the Run Contract). Written once (SELECT and INSERT only), one
//   per attempt: a run stopped for a real run gets a new contract when it is queued again.
// - `evaluations.base_sha`: the commit of the task set the runs start from (the sample repository).
// - `evaluation_runs.max_iterations`, `max_duration_min`: the caps of the configuration, copied at
//   start like the model, so the worker reads no configuration file.
// - The guard triggers of 0029 now also fix the new columns.
import { defineMigration } from './define.js';

const HEX64 = `~ '^[0-9a-f]{64}$'`;

export const migration0030EvaluationContracts = defineMigration({
  up: [
    `ALTER TABLE evaluations ADD COLUMN base_sha char(40) CHECK (base_sha ~ '^[0-9a-f]{40}$')`,
    `ALTER TABLE evaluation_runs
       ADD COLUMN max_iterations integer NOT NULL DEFAULT 30
         CHECK (max_iterations BETWEEN 1 AND 200),
       ADD COLUMN max_duration_min integer NOT NULL DEFAULT 20
         CHECK (max_duration_min BETWEEN 1 AND 120)`,

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
    `CREATE OR REPLACE FUNCTION evaluation_runs_guard() RETURNS trigger
       LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
     BEGIN
       IF (NEW.id, NEW.tenant_id, NEW.evaluation_id, NEW.configuration_id, NEW.task_id,
           NEW.run_index, NEW.model, NEW.provider_type, NEW.agent_version, NEW.created_at,
           NEW.max_iterations, NEW.max_duration_min)
          IS DISTINCT FROM
          (OLD.id, OLD.tenant_id, OLD.evaluation_id, OLD.configuration_id, OLD.task_id,
           OLD.run_index, OLD.model, OLD.provider_type, OLD.agent_version, OLD.created_at,
           OLD.max_iterations, OLD.max_duration_min) THEN
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
     END $$`,

    `CREATE TABLE evaluation_run_contracts (
       tenant_id         uuid NOT NULL,
       evaluation_run_id uuid NOT NULL,
       attempt           integer NOT NULL CHECK (attempt >= 1),
       contract_json     jsonb NOT NULL CHECK (jsonb_typeof(contract_json) = 'object'),
       contract_sha256   char(64) NOT NULL CHECK (contract_sha256 ${HEX64}),
       signature         text NOT NULL CHECK (
                           signature ~ '^vault:v[1-9][0-9]{0,8}:[A-Za-z0-9+/]+={0,2}$'
                           AND length(signature) <= 512),
       key_version       integer NOT NULL CHECK (key_version >= 1),
       issued_at         timestamptz NOT NULL,
       expires_at        timestamptz NOT NULL,
       revoked_at        timestamptz,
       created_at        timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT evaluation_run_contracts_pkey
         PRIMARY KEY (tenant_id, evaluation_run_id, attempt),
       CONSTRAINT evaluation_run_contracts_run_fkey FOREIGN KEY (tenant_id, evaluation_run_id)
         REFERENCES evaluation_runs (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT evaluation_run_contracts_validity CHECK (expires_at > issued_at),
       CONSTRAINT evaluation_run_contracts_key_version CHECK (
         signature LIKE 'vault:v' || key_version::text || ':%'),
       CONSTRAINT evaluation_run_contracts_same_run CHECK (
         contract_json ->> 'kind' = 'evaluation'
         AND contract_json ->> 'evaluation_run_id' = evaluation_run_id::text
         AND contract_json ->> 'tenant_id' = tenant_id::text
         AND (contract_json ->> 'attempt')::integer = attempt)
     )`,
    `CREATE TRIGGER evaluation_run_contracts_no_update_delete
       BEFORE UPDATE OR DELETE ON evaluation_run_contracts
       FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`,
    `CREATE TRIGGER evaluation_run_contracts_no_truncate
       BEFORE TRUNCATE ON evaluation_run_contracts
       FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()`,
    `REVOKE ALL ON evaluation_run_contracts FROM PUBLIC`,
    `GRANT SELECT, INSERT ON evaluation_run_contracts TO platform_app`,
  ],
  // Development only (ADR-M09). The guard functions of 0029 are restored by its own `down`.
  down: [
    `DROP TABLE evaluation_run_contracts`,
    `ALTER TABLE evaluation_runs DROP COLUMN max_duration_min, DROP COLUMN max_iterations`,
    `ALTER TABLE evaluations DROP COLUMN base_sha`,
  ],
});
