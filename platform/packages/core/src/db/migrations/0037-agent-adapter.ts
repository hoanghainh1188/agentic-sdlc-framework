// Migration 0037: the adapter of an agent (design/D-05 sections 6.1 and 6.9, version 1.55; D-08
// X03; design/ADR-M68 §7, ADR-M88; QUESTIONS #526). Rules for every migration: see the header of
// 0001-tenancy.ts and design/ADR-M09. Migrations 0029–0036 are merged and never edited.
//
// - `agents.adapter`: the code of the adapter that drives the agent (`openhands`, `opencode`).
//   Existing rows get `openhands`. It is part of the agent's configuration: the trigger of
//   migration 0008 now allows a change only with a new version, while `proposed` or `suspended`
//   (handbook Ch.20 §20.9).
// - `evaluation_runs.adapter`, `evaluation_configurations.adapter`: the adapter an evaluation run
//   uses, copied from its configuration at the start. The evaluation fingerprint compares it
//   (ADR-M86 §2.1). Existing rows get `openhands`, the only adapter before X03. The guard of
//   `evaluation_runs` fixes the new column; `evaluation_configurations` is append-only already.
import { defineMigration } from './define.js';

const ADAPTER = `text NOT NULL DEFAULT 'openhands' CHECK (adapter IN ('openhands', 'opencode'))`;

// The configuration columns of migration 0008, and the adapter.
const configColumns = (adapter: boolean): string[] => [
  'model_ref',
  'instructions_ref',
  'instructions_sha256',
  'allowed_tools',
  'max_autonomy',
  'approved_environments',
  ...(adapter ? ['adapter'] : []),
];

const agentsChanges = (adapter: boolean) => `CREATE OR REPLACE FUNCTION agents_changes()
       RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
     BEGIN
       IF OLD.status = 'retired' THEN
         RAISE EXCEPTION 'agent %: retired', OLD.id USING ERRCODE = 'SDA09';
       END IF;
       IF NEW.status <> OLD.status AND NOT (
            (OLD.status = 'proposed'    AND NEW.status IN ('active', 'retired'))
         OR (OLD.status = 'active'      AND NEW.status IN ('suspended', 'quarantined', 'retired'))
         OR (OLD.status = 'suspended'   AND NEW.status IN ('active', 'quarantined', 'retired'))
         OR (OLD.status = 'quarantined' AND NEW.status IN ('suspended', 'retired'))) THEN
         RAISE EXCEPTION 'agent %: status % cannot become %', OLD.id, OLD.status, NEW.status
           USING ERRCODE = 'SDA09';
       END IF;
       IF NEW.version IS DISTINCT FROM OLD.version
          OR ${configColumns(adapter)
            .map((c) => `NEW.${c} IS DISTINCT FROM OLD.${c}`)
            .join('\n          OR ')}
       THEN
         IF OLD.status NOT IN ('proposed', 'suspended') OR NEW.status <> OLD.status
            OR NEW.version = OLD.version THEN
           RAISE EXCEPTION 'agent %: configuration changes need a new version while proposed or suspended',
             OLD.id USING ERRCODE = 'SDA09';
         END IF;
       END IF;
       IF NEW.last_recertified_at IS DISTINCT FROM OLD.last_recertified_at
          AND (NEW.last_recertified_at IS NULL OR NEW.last_recertified_at < OLD.last_recertified_at) THEN
         RAISE EXCEPTION 'agent %: the recertification date never goes back', OLD.id
           USING ERRCODE = 'SDA09';
       END IF;
       RETURN NEW;
     END $$`;

// The guard of migration 0035, with one more fixed column.
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

export const migration0037AgentAdapter = defineMigration({
  up: [
    `ALTER TABLE agents ADD COLUMN adapter ${ADAPTER}`,
    agentsChanges(true),
    `GRANT UPDATE (adapter) ON agents TO platform_app`,

    `ALTER TABLE evaluation_runs ADD COLUMN adapter ${ADAPTER}`,
    runsGuard(', #.base_sha, #.adapter'),
    `ALTER TABLE evaluation_configurations ADD COLUMN adapter ${ADAPTER}`,
  ],
  // Development only (ADR-M09).
  down: [
    `ALTER TABLE evaluation_configurations DROP COLUMN adapter`,
    runsGuard(', #.base_sha'),
    `ALTER TABLE evaluation_runs DROP COLUMN adapter`,
    `REVOKE UPDATE (adapter) ON agents FROM platform_app`,
    agentsChanges(false),
    `ALTER TABLE agents DROP COLUMN adapter`,
  ],
});
