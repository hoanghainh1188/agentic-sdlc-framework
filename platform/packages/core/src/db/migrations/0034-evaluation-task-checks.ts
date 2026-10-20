// Migration 0034: the check of a project's evaluation task (design/D-05 section 6.10, version
// 1.51; D-08 L07; design/ADR-M85 §2.5; QUESTIONS #488). Rules for every migration: see the header
// of 0001-tenancy.ts and design/ADR-M09. Migration 0033 is merged and never edited.
//
// - `evaluation_tasks.check_attempt`: how many times the check of the current card was handed to
//   a runner. It goes back to 0 when a changed card is registered again.
// - `evaluation_task_check_contracts`: the signed contract of one check attempt (kind
//   `evaluation_task_check`, the same Transit key as the Run Contract). Written once (SELECT and
//   INSERT only), one per attempt and card. Codes, IDs, commits and hashes only: never a path of
//   the project or the spec.
import { defineMigration } from './define.js';

const HEX64 = `~ '^[0-9a-f]{64}$'`;

export const migration0034EvaluationTaskChecks = defineMigration({
  up: [
    `ALTER TABLE evaluation_tasks
       ADD COLUMN check_attempt integer NOT NULL DEFAULT 0 CHECK (check_attempt >= 0)`,
    `GRANT UPDATE (check_attempt) ON evaluation_tasks TO platform_app`,

    `CREATE TABLE evaluation_task_check_contracts (
       tenant_id           uuid NOT NULL,
       evaluation_task_id  uuid NOT NULL,
       card_sha256         char(64) NOT NULL CHECK (card_sha256 ${HEX64}),
       attempt             integer NOT NULL CHECK (attempt >= 1),
       contract_json       jsonb NOT NULL CHECK (jsonb_typeof(contract_json) = 'object'),
       contract_sha256     char(64) NOT NULL CHECK (contract_sha256 ${HEX64}),
       signature           text NOT NULL CHECK (
                             signature ~ '^vault:v[1-9][0-9]{0,8}:[A-Za-z0-9+/]+={0,2}$'
                             AND length(signature) <= 512),
       key_version         integer NOT NULL CHECK (key_version >= 1),
       issued_at           timestamptz NOT NULL,
       expires_at          timestamptz NOT NULL,
       created_at          timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT evaluation_task_check_contracts_pkey
         PRIMARY KEY (tenant_id, evaluation_task_id, card_sha256, attempt),
       CONSTRAINT evaluation_task_check_contracts_task_fkey FOREIGN KEY (tenant_id, evaluation_task_id)
         REFERENCES evaluation_tasks (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT evaluation_task_check_contracts_validity CHECK (expires_at > issued_at),
       CONSTRAINT evaluation_task_check_contracts_key_version CHECK (
         signature LIKE 'vault:v' || key_version::text || ':%'),
       CONSTRAINT evaluation_task_check_contracts_same_task CHECK (
         contract_json ->> 'kind' = 'evaluation_task_check'
         AND contract_json ->> 'evaluation_task_id' = evaluation_task_id::text
         AND contract_json ->> 'tenant_id' = tenant_id::text
         AND contract_json ->> 'card_sha256' = card_sha256::text
         AND (contract_json ->> 'attempt')::integer = attempt)
     )`,
    `CREATE TRIGGER evaluation_task_check_contracts_no_update_delete
       BEFORE UPDATE OR DELETE ON evaluation_task_check_contracts
       FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`,
    `CREATE TRIGGER evaluation_task_check_contracts_no_truncate
       BEFORE TRUNCATE ON evaluation_task_check_contracts
       FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()`,
    `REVOKE ALL ON evaluation_task_check_contracts FROM PUBLIC`,
    `GRANT SELECT, INSERT ON evaluation_task_check_contracts TO platform_app`,
    // The worker's check loop looks for tasks being checked across tenants (a lost workflow).
    `CREATE INDEX evaluation_tasks_checking ON evaluation_tasks (updated_at)
       WHERE status = 'checking'`,
  ],
  // Development only (ADR-M09).
  down: [
    `DROP INDEX IF EXISTS evaluation_tasks_checking`,
    `DROP TABLE IF EXISTS evaluation_task_check_contracts`,
    `ALTER TABLE evaluation_tasks DROP COLUMN IF EXISTS check_attempt`,
  ],
});
