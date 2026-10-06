// Migration 0024: the Langfuse purge of each intent (design/D-05 sections 6.6 and 10.1, version
// 1.35; D-08 E08; D-02 FR-44; design/ADR-M53; QUESTIONS #253). Rules for every migration: see the
// header of 0001-tenancy.ts and design/ADR-M09.
//
// - One row per intent whose model-call traces the worker's retention loop asked Langfuse to
//   delete. Langfuse deletes later (asynchronously): `confirmed_at` is set once, on a later pass,
//   when the traces are no longer found. A confirmed row never changes again.
// - Without this table the loop would ask Langfuse about every finished intent on every pass.
// - Codes, counts and times only: never a trace ID, a tag or text (the table is kept with the
//   intents). Rows are never deleted. Only `traces`, `attempts`, `last_requested_at` (a new request
//   for an unconfirmed row) and `confirmed_at` change; `attempts` only grows (trigger `SDA17`).
import { defineMigration } from './define.js';

export const migration0024LangfusePurges = defineMigration({
  up: [
    `CREATE TABLE langfuse_purges (
       tenant_id          uuid NOT NULL,
       intent_id          uuid NOT NULL,
       cause              text NOT NULL CHECK (cause IN ('retention', 'archive')),
       traces             integer NOT NULL CHECK (traces >= 0),
       attempts           smallint NOT NULL DEFAULT 1 CHECK (attempts >= 1),
       requested_at       timestamptz NOT NULL,
       last_requested_at  timestamptz NOT NULL,
       confirmed_at       timestamptz,
       created_at         timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT langfuse_purges_pkey PRIMARY KEY (tenant_id, intent_id),
       CONSTRAINT langfuse_purges_times CHECK (last_requested_at >= requested_at),
       CONSTRAINT langfuse_purges_confirmed CHECK (
         confirmed_at IS NULL OR confirmed_at >= requested_at),
       CONSTRAINT langfuse_purges_intent_fkey FOREIGN KEY (tenant_id, intent_id)
         REFERENCES intents (tenant_id, id) ON DELETE RESTRICT
     )`,
    `CREATE INDEX langfuse_purges_unconfirmed ON langfuse_purges (tenant_id, intent_id)
       WHERE confirmed_at IS NULL`,
    `CREATE FUNCTION langfuse_purges_fixed() RETURNS trigger
       LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
     BEGIN
       IF (NEW.tenant_id, NEW.intent_id, NEW.cause, NEW.requested_at, NEW.created_at)
          IS DISTINCT FROM
          (OLD.tenant_id, OLD.intent_id, OLD.cause, OLD.requested_at, OLD.created_at) THEN
         RAISE EXCEPTION 'langfuse purge of intent %: only the request and confirm columns change',
           OLD.intent_id USING ERRCODE = 'SDA17';
       END IF;
       IF OLD.confirmed_at IS NOT NULL
          AND (NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
               OR NEW.traces IS DISTINCT FROM OLD.traces
               OR NEW.attempts IS DISTINCT FROM OLD.attempts
               OR NEW.last_requested_at IS DISTINCT FROM OLD.last_requested_at) THEN
         RAISE EXCEPTION 'langfuse purge of intent %: confirmed once, then fixed', OLD.intent_id
           USING ERRCODE = 'SDA17';
       END IF;
       IF NEW.attempts < OLD.attempts OR NEW.last_requested_at < OLD.last_requested_at THEN
         RAISE EXCEPTION 'langfuse purge of intent %: attempts only grow', OLD.intent_id
           USING ERRCODE = 'SDA17';
       END IF;
       RETURN NEW;
     END $$`,
    `CREATE TRIGGER langfuse_purges_fixed BEFORE UPDATE ON langfuse_purges
       FOR EACH ROW EXECUTE FUNCTION langfuse_purges_fixed()`,
    `CREATE TRIGGER langfuse_purges_no_delete BEFORE DELETE ON langfuse_purges
       FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`,
    `CREATE TRIGGER langfuse_purges_no_truncate BEFORE TRUNCATE ON langfuse_purges
       FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()`,
    `REVOKE ALL ON langfuse_purges FROM PUBLIC`,
    `GRANT SELECT, INSERT ON langfuse_purges TO platform_app`,
    `GRANT UPDATE (traces, attempts, last_requested_at, confirmed_at) ON langfuse_purges
       TO platform_app`,
  ],
  // Development only (ADR-M09).
  down: [`DROP TABLE langfuse_purges`, `DROP FUNCTION langfuse_purges_fixed()`],
});
