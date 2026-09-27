// Migration 0007: escalations, their notices, and the link from Git event receipts (design/D-05
// sections 5, 6.1b and 6.4b, version 1.9; D-08 B11; design/ADR-M28).
// Rules for every migration: see the header of 0001-tenancy.ts and design/ADR-M09.
//
// - `escalations` holds the current state of an escalation. It is not append-only, but it is kept
//   at least 2 years (D-05 section 10), so it holds codes, IDs, hashes and references only, never
//   free text or personal or client data (CLAUDE.md "Current constraints"). `packet` and
//   `decision` are flat coded objects; a CHECK refuses anything else.
// - The clocks live in the row (ADR-M28, QUESTIONS #73): `step_due_at`, `remind_at` and
//   `resolve_due_at`, with `next_check_at` = the earliest pending one, which the worker loop reads.
// - `platform_app` may update only the state, clock, acknowledgement and decision columns. A
//   trigger allows only the status moves of ADR-M28 §2.4 and refuses any change once `closed`.
// - `escalation_notices` is the outbox of the notices the clock records (task B11 PR 2 posts them).
// - `git_event_receipts.escalation_id` links a `/ack` or `/decide` comment to its escalation (PR 2).
//
// Custom SQLSTATE (translated in errors.ts):
//   SDA07  an escalation status move that is not allowed, or a change to a closed escalation
//   SDA08  a notice that was posted or abandoned is final
import { defineMigration } from './define.js';

const CODE = `~ '^[a-z][a-z0-9_]{0,63}$'`;

export const migration0007Escalations = defineMigration({
  up: [
    `CREATE TYPE escalation_trigger AS ENUM
       ('risky_action', 'uncertainty', 'out_of_scope', 'disagreement', 'unusual_behaviour',
        'accumulated_risk', 'time')`,
    `CREATE TYPE severity AS ENUM ('critical', 'high', 'medium', 'low')`,
    `CREATE TYPE response_level AS ENUM ('observe', 'notify', 'pause', 'contain', 'incident')`,
    `CREATE TYPE escalation_status AS ENUM ('open', 'acknowledged', 'resolved', 'closed')`,
    `CREATE TYPE escalation_route AS ENUM ('intent', 'technical', 'security', 'policy')`,
    `CREATE TYPE escalation_step AS ENUM ('owner', 'backup', 'governance')`,

    // Coded objects only (ADR-M28 §2.3): flat, at most 16 keys and 2048 bytes. Values are short
    // codes without spaces or '@', small integers, or booleans; the one key `ref` may hold an
    // https link (for example the Git host comment that explains the decision).
    `CREATE FUNCTION escalation_object_is_coded(value jsonb) RETURNS boolean
       LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
       SELECT jsonb_typeof(value) = 'object'
         AND octet_length(value::text) <= 2048
         AND (SELECT count(*) FROM jsonb_each(value)) <= 16
         AND NOT EXISTS (
           SELECT 1 FROM jsonb_each(value) AS e(key, item)
           WHERE e.key !~ '^[a-z][a-z0-9_]{0,63}$'
              OR NOT (
                (e.key = 'ref' AND jsonb_typeof(e.item) = 'string'
                   AND (e.item #>> '{}') ~ '^https://[^[:space:]@]+$'
                   AND length(e.item #>> '{}') <= 512)
                OR (e.key <> 'ref' AND jsonb_typeof(e.item) = 'string'
                   AND (e.item #>> '{}') ~ '^[A-Za-z0-9._:/+-]{1,128}$')
                OR (jsonb_typeof(e.item) = 'number' AND e.item::text ~ '^[0-9]{1,15}$')
                OR jsonb_typeof(e.item) = 'boolean'))
     $$`,

    `CREATE TABLE escalations (
       id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id             uuid NOT NULL,
       code                  text NOT NULL CHECK (code ~ '^ESC-[0-9]{4}-[0-9]{4,9}$'),
       intent_id             uuid NOT NULL,
       run_id                uuid,
       trigger               escalation_trigger NOT NULL,
       route                 escalation_route NOT NULL,
       severity              severity NOT NULL,
       response_level        response_level NOT NULL,
       packet                jsonb NOT NULL CHECK (escalation_object_is_coded(packet)),
       -- Producers of the change: never owner, backup or decider (FR-18). IDs only.
       producer_ids          uuid[] NOT NULL DEFAULT '{}'
                               CHECK (cardinality(producer_ids) <= 32
                                      AND array_position(producer_ids, NULL) IS NULL),
       -- Null when the role has no holder (QUESTIONS #74): that step is skipped.
       owner_id              uuid,
       backup_owner_id       uuid,
       current_step          escalation_step NOT NULL,
       status                escalation_status NOT NULL DEFAULT 'open',
       -- The first acknowledge deadline (SLA), kept for metrics; each step has its own below.
       ack_due_at            timestamptz NOT NULL,
       step_due_at           timestamptz NOT NULL,
       remind_at             timestamptz,
       reminded_step         escalation_step,
       -- First missed acknowledgement: freezes observe and notify levels from then on (#76).
       ack_missed_at         timestamptz,
       -- Governance, the last step, missed its acknowledge window too.
       governance_overdue_at timestamptz,
       -- Null: "next planned work", no resolve clock (Ch.6 §6.4, Low).
       resolve_due_at        timestamptz,
       resolve_overdue_at    timestamptz,
       -- Earliest pending clock; null when nothing is pending. Read by the worker loop.
       next_check_at         timestamptz,
       acknowledged_by       uuid,
       acknowledged_at       timestamptz,
       decision              jsonb CHECK (decision IS NULL OR escalation_object_is_coded(decision)),
       decided_by            uuid,
       decided_at            timestamptz,
       closed_at             timestamptz,
       updated_at            timestamptz NOT NULL DEFAULT now(),
       created_at            timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT escalations_tenant_id_id_key UNIQUE (tenant_id, id),
       CONSTRAINT escalations_tenant_id_code_key UNIQUE (tenant_id, code),
       CONSTRAINT escalations_intent_fkey FOREIGN KEY (tenant_id, intent_id)
         REFERENCES intents (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT escalations_run_fkey FOREIGN KEY (tenant_id, run_id)
         REFERENCES runs (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT escalations_owner_fkey FOREIGN KEY (tenant_id, owner_id)
         REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT escalations_backup_owner_fkey FOREIGN KEY (tenant_id, backup_owner_id)
         REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT escalations_acknowledged_by_fkey FOREIGN KEY (tenant_id, acknowledged_by)
         REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT escalations_decided_by_fkey FOREIGN KEY (tenant_id, decided_by)
         REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT escalations_owner_not_backup CHECK (owner_id IS DISTINCT FROM backup_owner_id
         OR owner_id IS NULL),
       CONSTRAINT escalations_owner_not_producer CHECK (
         (owner_id IS NULL OR NOT owner_id = ANY (producer_ids))
         AND (backup_owner_id IS NULL OR NOT backup_owner_id = ANY (producer_ids))),
       CONSTRAINT escalations_ack_pair CHECK ((acknowledged_by IS NULL) = (acknowledged_at IS NULL)),
       CONSTRAINT escalations_decision_triple CHECK (
         (decision IS NULL) = (decided_by IS NULL) AND (decided_by IS NULL) = (decided_at IS NULL)),
       -- The approver never is the producer (FR-18); agents never decide (humans only in users).
       CONSTRAINT escalations_ack_not_producer CHECK (
         acknowledged_by IS NULL OR NOT acknowledged_by = ANY (producer_ids)),
       CONSTRAINT escalations_decider_not_producer CHECK (
         decided_by IS NULL OR NOT decided_by = ANY (producer_ids)),
       CONSTRAINT escalations_status_fields CHECK (
         CASE status
           WHEN 'open' THEN decision IS NULL AND closed_at IS NULL
           WHEN 'acknowledged' THEN acknowledged_at IS NOT NULL AND decision IS NULL
                                    AND closed_at IS NULL
           WHEN 'resolved' THEN decision IS NOT NULL AND closed_at IS NULL
           WHEN 'closed' THEN closed_at IS NOT NULL AND next_check_at IS NULL
         END),
       CONSTRAINT escalations_reminded_needs_remind CHECK (
         reminded_step IS NULL OR remind_at IS NOT NULL)
     )`,
    `CREATE INDEX escalations_tenant_id_intent_id_status_idx
       ON escalations (tenant_id, intent_id, status)`,
    // The worker loop reads due escalations across tenants (SystemScope, ADR-M28 §2.2).
    `CREATE INDEX escalations_next_check_at_idx ON escalations (next_check_at)
       WHERE next_check_at IS NOT NULL`,

    // Allowed status moves (ADR-M28 §2.4). A decision found expired or mismatched is voided:
    // resolved → acknowledged. Nothing changes once closed. The acknowledgement is written once.
    `CREATE FUNCTION escalations_status_moves() RETURNS trigger
       LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
     BEGIN
       IF OLD.status = 'closed' THEN
         RAISE EXCEPTION 'escalation %: closed', OLD.id USING ERRCODE = 'SDA07';
       END IF;
       IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
            (OLD.status = 'open' AND NEW.status IN ('acknowledged', 'resolved', 'closed'))
         OR (OLD.status = 'acknowledged' AND NEW.status IN ('resolved', 'closed'))
         OR (OLD.status = 'resolved' AND NEW.status IN ('acknowledged', 'closed'))) THEN
         RAISE EXCEPTION 'escalation %: % → % not allowed', OLD.id, OLD.status, NEW.status
           USING ERRCODE = 'SDA07';
       END IF;
       IF OLD.acknowledged_at IS NOT NULL AND (
            NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at
            OR NEW.acknowledged_by IS DISTINCT FROM OLD.acknowledged_by) THEN
         RAISE EXCEPTION 'escalation %: already acknowledged', OLD.id USING ERRCODE = 'SDA07';
       END IF;
       -- A decision is replaced only by clearing it (void, back to acknowledged).
       IF OLD.decision IS NOT NULL AND NEW.decision IS NOT NULL
          AND NEW.decision IS DISTINCT FROM OLD.decision THEN
         RAISE EXCEPTION 'escalation %: decision already recorded', OLD.id USING ERRCODE = 'SDA07';
       END IF;
       RETURN NEW;
     END $$`,
    `CREATE TRIGGER escalations_status_moves BEFORE UPDATE ON escalations
       FOR EACH ROW EXECUTE FUNCTION escalations_status_moves()`,

    `CREATE TABLE escalation_notices (
       id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
       tenant_id     uuid NOT NULL,
       escalation_id uuid NOT NULL,
       kind          text NOT NULL CHECK (kind ${CODE}),
       step          escalation_step NOT NULL,
       audience_role project_role NOT NULL CHECK (audience_role <> 'viewer'),
       attempts      smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 100),
       posted_at     timestamptz,
       abandoned_at  timestamptz,
       created_at    timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT escalation_notices_escalation_fkey FOREIGN KEY (tenant_id, escalation_id)
         REFERENCES escalations (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT escalation_notices_once UNIQUE (tenant_id, escalation_id, kind, step,
                                                  audience_role),
       CONSTRAINT escalation_notices_delivered_once CHECK (
         posted_at IS NULL OR abandoned_at IS NULL)
     )`,
    `CREATE INDEX escalation_notices_pending_idx ON escalation_notices (tenant_id, id)
       WHERE posted_at IS NULL AND abandoned_at IS NULL`,
    `CREATE FUNCTION escalation_notices_delivery_is_final() RETURNS trigger
       LANGUAGE plpgsql AS $$
       BEGIN
         IF OLD.posted_at IS NOT NULL OR OLD.abandoned_at IS NOT NULL
            OR NEW.attempts < OLD.attempts THEN
           RAISE EXCEPTION 'escalation_notices: notice % is final', OLD.id
             USING ERRCODE = 'SDA08';
         END IF;
         RETURN NEW;
       END $$`,
    `CREATE TRIGGER escalation_notices_delivery_is_final BEFORE UPDATE ON escalation_notices
       FOR EACH ROW EXECUTE FUNCTION escalation_notices_delivery_is_final()`,

    // `/ack` and `/decide` comments (PR 2): the receipt names the escalation it acted on. Once the
    // receipt's result is set, the link is fixed like the gate decision (migration 0006).
    `ALTER TABLE git_event_receipts ADD COLUMN escalation_id uuid`,
    `ALTER TABLE git_event_receipts ADD CONSTRAINT git_event_receipts_escalation_fkey
       FOREIGN KEY (tenant_id, escalation_id) REFERENCES escalations (tenant_id, id)
       ON DELETE RESTRICT`,
    `ALTER TABLE git_event_receipts ADD CONSTRAINT git_event_receipts_one_subject CHECK (
       gate_decision_id IS NULL OR escalation_id IS NULL)`,
    `ALTER TABLE git_event_receipts ADD CONSTRAINT git_event_receipts_failing_no_escalation CHECK (
       outcome NOT IN ('failing', 'failed_internal') OR escalation_id IS NULL)`,
    `CREATE OR REPLACE FUNCTION git_event_receipts_delivery_is_final() RETURNS trigger
       LANGUAGE plpgsql AS $$
       BEGIN
         IF (OLD.outcome <> 'failing'
             AND (NEW.outcome IS DISTINCT FROM OLD.outcome
                  OR NEW.gate_decision_id IS DISTINCT FROM OLD.gate_decision_id
                  OR NEW.escalation_id IS DISTINCT FROM OLD.escalation_id
                  OR NEW.reply_code IS DISTINCT FROM OLD.reply_code
                  OR NEW.reply_params IS DISTINCT FROM OLD.reply_params
                  OR NEW.event_attempts IS DISTINCT FROM OLD.event_attempts))
            OR NEW.event_attempts < OLD.event_attempts
            OR NEW.reply_attempts < OLD.reply_attempts
            OR OLD.reply_posted_at IS NOT NULL
            OR OLD.reply_abandoned_at IS NOT NULL THEN
           RAISE EXCEPTION 'git_event_receipts: receipt % is final', OLD.id
             USING ERRCODE = 'SDA06';
         END IF;
         RETURN NEW;
       END $$`,

    `REVOKE ALL ON escalations, escalation_notices FROM PUBLIC`,
    `GRANT SELECT, INSERT ON escalations, escalation_notices TO platform_app`,
    // State, clocks, acknowledgement and decision. `backup_owner_id` is chosen again just before
    // the owner step runs out (roles change hands); owner, trigger, packet and producers never change.
    `GRANT UPDATE (backup_owner_id, current_step, status, step_due_at, remind_at, reminded_step,
       ack_missed_at, governance_overdue_at, resolve_due_at, resolve_overdue_at, next_check_at,
       acknowledged_by, acknowledged_at, decision, decided_by, decided_at, closed_at, updated_at)
       ON escalations TO platform_app`,
    `GRANT UPDATE (attempts, posted_at, abandoned_at) ON escalation_notices TO platform_app`,
    `GRANT UPDATE (escalation_id) ON git_event_receipts TO platform_app`,
  ],
  down: [
    `REVOKE UPDATE (escalation_id) ON git_event_receipts FROM platform_app`,
    `CREATE OR REPLACE FUNCTION git_event_receipts_delivery_is_final() RETURNS trigger
       LANGUAGE plpgsql AS $$
       BEGIN
         IF (OLD.outcome <> 'failing'
             AND (NEW.outcome IS DISTINCT FROM OLD.outcome
                  OR NEW.gate_decision_id IS DISTINCT FROM OLD.gate_decision_id
                  OR NEW.reply_code IS DISTINCT FROM OLD.reply_code
                  OR NEW.reply_params IS DISTINCT FROM OLD.reply_params
                  OR NEW.event_attempts IS DISTINCT FROM OLD.event_attempts))
            OR NEW.event_attempts < OLD.event_attempts
            OR NEW.reply_attempts < OLD.reply_attempts
            OR OLD.reply_posted_at IS NOT NULL
            OR OLD.reply_abandoned_at IS NOT NULL THEN
           RAISE EXCEPTION 'git_event_receipts: receipt % is final', OLD.id
             USING ERRCODE = 'SDA06';
         END IF;
         RETURN NEW;
       END $$`,
    `ALTER TABLE git_event_receipts DROP COLUMN escalation_id`,
    `DROP TABLE escalation_notices`,
    `DROP FUNCTION escalation_notices_delivery_is_final()`,
    `DROP TABLE escalations`,
    `DROP FUNCTION escalations_status_moves()`,
    `DROP FUNCTION escalation_object_is_coded(jsonb)`,
    `DROP TYPE escalation_step`,
    `DROP TYPE escalation_route`,
    `DROP TYPE escalation_status`,
    `DROP TYPE response_level`,
    `DROP TYPE severity`,
    `DROP TYPE escalation_trigger`,
  ],
});
