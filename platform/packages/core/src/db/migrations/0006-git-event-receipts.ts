// Migration 0006: receipts of Git host events (design/D-05 section 6.1b, version 1.8; D-08 B06;
// design/ADR-M27).
// Rules for every migration: see the header of 0001-tenancy.ts and design/ADR-M09.
//
// - One row per command comment the poller handled (`event_id`, for example
//   `github:comment:123`). The unique key makes the handler idempotent by event ID (ADR-M23
//   §2.3), together with the cursor saved in the same transaction.
// - The row is also the outbox of the reply comment: `reply_code` and `reply_params` say what to
//   post; the text is rendered from the message catalog when it is posted.
// - Codes, IDs and numbers only, never text from the Git host (CLAUDE.md "Current constraints").
// - Not append-only. A receipt with outcome `failing` (an event whose handling failed, counted in
//   its own transaction) gets its result once; after that only the reply delivery moves forward.
//
// Custom SQLSTATE (translated in errors.ts):
//   SDA06  a receipt is final: result set, or reply posted or abandoned
import { defineMigration } from './define.js';

// Event IDs of `GitEvent` (ADR-M23 §2.4): `<host>:<kind>:<numeric id>`.
const EVENT_ID = `~ '^[a-z]{2,16}:[a-z_]{2,32}:[0-9]{1,20}$'`;
const CODE = `~ '^[a-z][a-z0-9_]{0,63}$'`;

export const migration0006GitEventReceipts = defineMigration({
  up: [
    // Reply parameters: a flat object of at most 8 codes (gate codes, refusal reasons).
    `CREATE FUNCTION git_event_reply_params_are_coded(params jsonb) RETURNS boolean
       LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
       SELECT jsonb_typeof(params) = 'object'
         AND (SELECT count(*) FROM jsonb_each(params)) <= 8
         AND NOT EXISTS (
           SELECT 1 FROM jsonb_each(params) AS e(key, value)
           WHERE e.key !~ '^[a-z][a-z0-9_]{0,31}$'
              OR jsonb_typeof(e.value) <> 'string'
              OR (e.value #>> '{}') !~ '^[A-Za-z0-9_]{1,64}$')
     $$`,

    `CREATE TABLE git_event_receipts (
       -- Identity: receipts of one batch share created_at; replies go out in event order.
       id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
       tenant_id          uuid NOT NULL,
       project_id         uuid NOT NULL,
       event_id           text NOT NULL CHECK (event_id ${EVENT_ID}),
       outcome            text NOT NULL CHECK (outcome ${CODE}),
       gate_decision_id   uuid,
       issue_number       integer CHECK (issue_number >= 1),
       reply_code         text CHECK (reply_code ${CODE}),
       reply_params       jsonb CHECK (git_event_reply_params_are_coded(reply_params)),
       -- Failed handling attempts (errors other than refusals), counted outside the batch.
       event_attempts     smallint NOT NULL DEFAULT 0 CHECK (event_attempts BETWEEN 0 AND 100),
       reply_attempts     smallint NOT NULL DEFAULT 0 CHECK (reply_attempts BETWEEN 0 AND 100),
       reply_posted_at    timestamptz,
       reply_abandoned_at timestamptz,
       created_at         timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT git_event_receipts_event_key UNIQUE (tenant_id, project_id, event_id),
       CONSTRAINT git_event_receipts_project_fkey FOREIGN KEY (tenant_id, project_id)
         REFERENCES projects (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT git_event_receipts_gate_decision_fkey FOREIGN KEY (tenant_id, gate_decision_id)
         REFERENCES gate_decisions (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT git_event_receipts_reply_complete CHECK (
         (reply_code IS NULL) = (reply_params IS NULL)
         AND (reply_code IS NULL OR issue_number IS NOT NULL)),
       CONSTRAINT git_event_receipts_delivery_needs_reply CHECK (
         reply_code IS NOT NULL
         OR (reply_attempts = 0 AND reply_posted_at IS NULL AND reply_abandoned_at IS NULL)),
       CONSTRAINT git_event_receipts_delivered_once CHECK (
         reply_posted_at IS NULL OR reply_abandoned_at IS NULL),
       -- An event still being retried has recorded nothing yet.
       CONSTRAINT git_event_receipts_failing_is_empty CHECK (
         outcome <> 'failing' OR (gate_decision_id IS NULL AND reply_code IS NULL)),
       -- A final internal failure never records a gate decision.
       CONSTRAINT git_event_receipts_failed_has_no_decision CHECK (
         outcome <> 'failed_internal' OR gate_decision_id IS NULL)
     )`,
    // Replies still to post, per project (the outbox).
    `CREATE INDEX git_event_receipts_pending_reply_idx
       ON git_event_receipts (tenant_id, project_id, id)
       WHERE reply_code IS NOT NULL AND reply_posted_at IS NULL AND reply_abandoned_at IS NULL`,

    // Only a `failing` receipt (an event still being retried) may get its result; after that the
    // outcome, decision and reply are fixed. Counters never go down, and a delivered or abandoned
    // reply stays so.
    `CREATE FUNCTION git_event_receipts_delivery_is_final() RETURNS trigger
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
    `CREATE TRIGGER git_event_receipts_delivery_is_final
       BEFORE UPDATE ON git_event_receipts
       FOR EACH ROW EXECUTE FUNCTION git_event_receipts_delivery_is_final()`,

    `REVOKE ALL ON git_event_receipts FROM PUBLIC`,
    `GRANT SELECT, INSERT ON git_event_receipts TO platform_app`,
    `GRANT UPDATE (outcome, gate_decision_id, reply_code, reply_params, event_attempts,
                   reply_attempts, reply_posted_at, reply_abandoned_at)
       ON git_event_receipts TO platform_app`,
  ],
  down: [
    `DROP TABLE git_event_receipts`,
    `DROP FUNCTION git_event_receipts_delivery_is_final()`,
    `DROP FUNCTION git_event_reply_params_are_coded(jsonb)`,
  ],
});
