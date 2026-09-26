// Migration 0004: agent runs, Run Contracts and run events (design/D-05 sections 5, 6.4 and 9;
// D-03 section 8; D-08 C02; design/ADR-M22).
// Rules for every migration: see the header of 0001-tenancy.ts and design/ADR-M09.
//
// - `runs` holds the current state of a run. `platform_app` may update only the state columns,
//   and a trigger refuses any change once the status is final.
// - `run_contracts` is written once: SELECT and INSERT only. It is not append-only (D-05 D3),
//   so the purge job of E05 (maintenance role) can still clear client paths later.
// - `run_events` is append-only (D-05 D3) and kept like the other evidence tables, so its
//   payload holds coded values only, never free text (CLAUDE.md, ADR-M22 section 2.5). The
//   repository accepts only the fields declared per event type; the CHECK below is the backstop.
// - `runs.agent_id` has no foreign key yet: the agent register comes with C10, which adds
//   `(tenant_id, agent_id) → agents` (QUESTIONS.md #32).
//
// Errors raised by the triggers (class `SD`, mapped in errors.ts):
//   SDA05  a run in a final status can never change
import { defineMigration } from './define.js';

const HEX64 = `~ '^[0-9a-f]{64}$'`;
const HEX40 = `~ '^[0-9a-f]{40}$'`;
const FINAL = `'succeeded', 'succeeded_proposal_only', 'failed', 'stopped_budget', 'stopped_scope',
  'stopped_timeout', 'stopped_stalled', 'stopped_killed', 'cancelled'`;

export const migration0004Runs = defineMigration({
  up: [
    `CREATE TYPE run_status AS ENUM
       ('queued', 'provisioning', 'running', 'stopping', 'succeeded', 'succeeded_proposal_only',
        'failed', 'stopped_budget', 'stopped_scope', 'stopped_timeout', 'stopped_stalled',
        'stopped_killed', 'cancelled')`,

    `CREATE TABLE runs (
       id            uuid PRIMARY KEY,
       tenant_id     uuid NOT NULL,
       intent_id     uuid NOT NULL,
       plan_id       uuid NOT NULL,
       attempt       integer NOT NULL CHECK (attempt >= 1),
       agent_id      uuid NOT NULL,
       agent_version text NOT NULL CHECK (agent_version ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$'),
       branch        text NOT NULL CHECK (branch ~ '^agent/INT-[0-9]{4}-[0-9]{4,9}$'),
       base_sha      char(40) NOT NULL CHECK (base_sha ${HEX40}),
       head_sha      char(40) CHECK (head_sha ${HEX40}),
       status        run_status NOT NULL DEFAULT 'queued',
       -- A code, never free text (D-02 FR-32: the reason also goes to the audit log).
       stop_reason   text CHECK (stop_reason ~ '^[a-z][a-z0-9_]{0,63}$'),
       triggered_by  uuid,
       started_at    timestamptz,
       finished_at   timestamptz,
       iterations    integer NOT NULL DEFAULT 0 CHECK (iterations >= 0),
       killed_by     uuid,
       updated_at    timestamptz NOT NULL DEFAULT now(),
       created_at    timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT runs_tenant_id_id_key UNIQUE (tenant_id, id),
       CONSTRAINT runs_tenant_id_intent_id_attempt_key UNIQUE (tenant_id, intent_id, attempt),
       CONSTRAINT runs_intent_fkey FOREIGN KEY (tenant_id, intent_id)
         REFERENCES intents (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT runs_plan_fkey FOREIGN KEY (tenant_id, plan_id)
         REFERENCES plans (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT runs_triggered_by_fkey FOREIGN KEY (tenant_id, triggered_by)
         REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT runs_killed_by_fkey FOREIGN KEY (tenant_id, killed_by)
         REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT runs_finished_after_start CHECK (
         finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at),
       CONSTRAINT runs_killed_status CHECK (killed_by IS NULL OR status = 'stopped_killed')
     )`,
    `CREATE INDEX runs_tenant_id_status_idx ON runs (tenant_id, status)`,

    `CREATE FUNCTION runs_final_status_is_final() RETURNS trigger
       LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
     BEGIN
       IF OLD.status IN (${FINAL}) THEN
         RAISE EXCEPTION 'run %: status % is final', OLD.id, OLD.status USING ERRCODE = 'SDA05';
       END IF;
       RETURN NEW;
     END $$`,
    `CREATE TRIGGER runs_final_status_is_final BEFORE UPDATE ON runs
       FOR EACH ROW EXECUTE FUNCTION runs_final_status_is_final()`,

    `CREATE TABLE run_contracts (
       run_id          uuid PRIMARY KEY,
       tenant_id       uuid NOT NULL,
       contract_json   jsonb NOT NULL CHECK (jsonb_typeof(contract_json) = 'object'),
       contract_sha256 char(64) NOT NULL CHECK (contract_sha256 ${HEX64}),
       signature       text NOT NULL CHECK (
                         signature ~ '^vault:v[1-9][0-9]{0,8}:[A-Za-z0-9+/]+={0,2}$'
                         AND length(signature) <= 512),
       key_version     integer NOT NULL CHECK (key_version >= 1),
       issued_at       timestamptz NOT NULL,
       expires_at      timestamptz NOT NULL,
       -- Revocation is MVP+ (D-05 section 6.4): no UPDATE grant yet; the runner already checks it.
       revoked_at      timestamptz,
       created_at      timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT run_contracts_run_fkey FOREIGN KEY (tenant_id, run_id)
         REFERENCES runs (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT run_contracts_validity CHECK (expires_at > issued_at),
       CONSTRAINT run_contracts_key_version CHECK (
         signature LIKE 'vault:v' || key_version::text || ':%'),
       CONSTRAINT run_contracts_same_run CHECK (
         contract_json ->> 'run_id' = run_id::text
         AND contract_json ->> 'tenant_id' = tenant_id::text)
     )`,

    // Coded payloads only (ADR-M22 section 2.5): a flat object of at most 32 keys and 2048 bytes;
    // values are integers, booleans or short strings without spaces and without '@' (so neither
    // sentences nor e-mail addresses fit).
    `CREATE FUNCTION run_event_payload_is_coded(payload jsonb) RETURNS boolean
       LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
       SELECT jsonb_typeof(payload) = 'object'
         AND octet_length(payload::text) <= 2048
         AND (SELECT count(*) FROM jsonb_each(payload)) <= 32
         AND NOT EXISTS (
           SELECT 1 FROM jsonb_each(payload) AS e(key, value)
           WHERE e.key !~ '^[a-z][a-z0-9_]{0,63}$'
              OR NOT (
                (jsonb_typeof(e.value) = 'string'
                   AND (e.value #>> '{}') ~ '^[A-Za-z0-9._:/-]{1,128}$')
                OR (jsonb_typeof(e.value) = 'number' AND e.value::text ~ '^[0-9]{1,15}$')
                OR jsonb_typeof(e.value) = 'boolean'))
     $$`,

    `CREATE TABLE run_events (
       id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
       tenant_id  uuid NOT NULL,
       run_id     uuid NOT NULL,
       event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_]{0,63}$'),
       payload    jsonb NOT NULL CHECK (run_event_payload_is_coded(payload)),
       created_at timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT run_events_run_fkey FOREIGN KEY (tenant_id, run_id)
         REFERENCES runs (tenant_id, id) ON DELETE RESTRICT
     )`,
    `CREATE INDEX run_events_tenant_id_run_id_id_idx ON run_events (tenant_id, run_id, id)`,

    `CREATE TRIGGER run_events_no_update_delete BEFORE UPDATE OR DELETE ON run_events
       FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`,
    `CREATE TRIGGER run_events_no_truncate BEFORE TRUNCATE ON run_events
       FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()`,

    `REVOKE ALL ON runs, run_contracts, run_events FROM PUBLIC`,
    `GRANT SELECT, INSERT ON runs, run_contracts, run_events TO platform_app`,
    // Current state of the run (C04, C07, C11 write it); identity and inputs never change.
    `GRANT UPDATE (status, stop_reason, head_sha, started_at, finished_at, iterations, killed_by,
       updated_at) ON runs TO platform_app`,
  ],
  down: [
    `DROP TABLE run_events`,
    `DROP FUNCTION run_event_payload_is_coded(jsonb)`,
    `DROP TABLE run_contracts`,
    `DROP TABLE runs`,
    `DROP FUNCTION runs_final_status_is_final()`,
    `DROP TYPE run_status`,
  ],
});
