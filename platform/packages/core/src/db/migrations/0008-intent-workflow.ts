// Migration 0008: what the intent workflow needs (design/D-05 sections 6.2 and 6.2b, version
// 1.11; D-08 B07; design/ADR-M30; QUESTIONS #68, #91).
// Rules for every migration: see the header of 0001-tenancy.ts and design/ADR-M09.
//
// - `intents.gate_entered_at`: when the intent last entered its current gate. Approvals and other
//   decisions count only when recorded after it (a gate entered again needs a fresh decision), and
//   it gives the waiting time of a gate (FR-12, E06).
// - One open intent per issue and per pull request of a project (QUESTIONS #68 option A): a comment
//   command always names exactly one intent. Closed intents (`done`, `rejected`, `cancelled`) keep
//   their numbers.
// - An index on the audit log by entity: the workflow reads an intent's gate history in chain
//   order (`seq`), which is exact where timestamps of concurrent transactions are not (ADR-M30).
// - `intent_notices` is the outbox of the gate status comments (FR-22). The workflow records one
//   notice per status change, in the transaction of the change; the poller posts it. Codes and IDs
//   only: the text comes from the message catalog when the comment is posted.
//
// Custom SQLSTATE (translated in errors.ts):
//   SDA09  a status notice that was posted or abandoned is final
import { defineMigration } from './define.js';

const CODE = `~ '^[a-z][a-z0-9_]{0,63}$'`;
const OPEN = `status NOT IN ('done', 'rejected', 'cancelled')`;

export const migration0008IntentWorkflow = defineMigration({
  up: [
    `ALTER TABLE intents ADD COLUMN gate_entered_at timestamptz`,
    `ALTER TABLE intents ADD CONSTRAINT intents_gate_entered_with_gate CHECK (
       current_gate IS NOT NULL OR gate_entered_at IS NULL)`,
    `GRANT UPDATE (gate_entered_at) ON intents TO platform_app`,

    `CREATE UNIQUE INDEX intents_open_issue_key ON intents (tenant_id, project_id, issue_number)
       WHERE issue_number IS NOT NULL AND ${OPEN}`,
    `CREATE UNIQUE INDEX intents_open_pr_key ON intents (tenant_id, project_id, pr_number)
       WHERE pr_number IS NOT NULL AND ${OPEN}`,

    `CREATE INDEX audit_log_tenant_entity_seq_idx ON audit_log (tenant_id, entity_id, seq)
       WHERE entity_id IS NOT NULL`,

    `CREATE TABLE intent_notices (
       id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
       tenant_id       uuid NOT NULL,
       intent_id       uuid NOT NULL,
       kind            text NOT NULL CHECK (kind ${CODE}),
       status          intent_status NOT NULL,
       gate            gate_code,
       previous_gate   gate_code,
       decision_id     uuid,
       audience_roles  project_role[] NOT NULL DEFAULT '{}' CHECK (
                         cardinality(audience_roles) <= 8
                         AND NOT ('viewer' = ANY (audience_roles))),
       attempts        smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 100),
       posted_at       timestamptz,
       abandoned_at    timestamptz,
       created_at      timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT intent_notices_intent_fkey FOREIGN KEY (tenant_id, intent_id)
         REFERENCES intents (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT intent_notices_decision_fkey FOREIGN KEY (tenant_id, decision_id)
         REFERENCES gate_decisions (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT intent_notices_delivered_once CHECK (posted_at IS NULL OR abandoned_at IS NULL)
     )`,
    `CREATE INDEX intent_notices_pending_idx ON intent_notices (tenant_id, id)
       WHERE posted_at IS NULL AND abandoned_at IS NULL`,
    `CREATE INDEX intent_notices_intent_idx ON intent_notices (tenant_id, intent_id)`,
    `CREATE FUNCTION intent_notices_delivery_is_final() RETURNS trigger
       LANGUAGE plpgsql AS $$
       BEGIN
         IF OLD.posted_at IS NOT NULL OR OLD.abandoned_at IS NOT NULL
            OR NEW.attempts < OLD.attempts THEN
           RAISE EXCEPTION 'intent_notices: notice % is final', OLD.id
             USING ERRCODE = 'SDA09';
         END IF;
         RETURN NEW;
       END $$`,
    `CREATE TRIGGER intent_notices_delivery_is_final BEFORE UPDATE ON intent_notices
       FOR EACH ROW EXECUTE FUNCTION intent_notices_delivery_is_final()`,

    `REVOKE ALL ON intent_notices FROM PUBLIC`,
    `GRANT SELECT, INSERT ON intent_notices TO platform_app`,
    `GRANT UPDATE (attempts, posted_at, abandoned_at) ON intent_notices TO platform_app`,
  ],
  down: [
    `DROP TABLE intent_notices`,
    `DROP FUNCTION intent_notices_delivery_is_final()`,
    `DROP INDEX audit_log_tenant_entity_seq_idx`,
    `DROP INDEX intents_open_pr_key`,
    `DROP INDEX intents_open_issue_key`,
    `REVOKE UPDATE (gate_entered_at) ON intents FROM platform_app`,
    `ALTER TABLE intents DROP CONSTRAINT intents_gate_entered_with_gate`,
    `ALTER TABLE intents DROP COLUMN gate_entered_at`,
  ],
});
