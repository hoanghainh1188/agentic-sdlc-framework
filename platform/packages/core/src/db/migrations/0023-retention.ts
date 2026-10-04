// Migration 0023: evidence retention (design/D-05 sections 6.6 and 10.1, version 1.33; D-08 E05;
// D-02 FR-44; design/ADR-M51; QUESTIONS #235). Rules for every migration: see the header of
// 0001-tenancy.ts and design/ADR-M09.
//
// - The purge (the worker's retention loop) deletes the files in SeaweedFS and keeps the rows and
//   their hashes: `purged_at` is set once, never cleared (triggers `SDA15` on `evidence_items`,
//   `SDA14` on `evidence_packs`). Rows are never deleted.
// - `lock_extended_until`: how far the loop moved the object lock of the row's files forward, for
//   projects that keep evidence longer than the bucket's default lock (180 days). It only grows.
// - `evidence_holds` (QUESTIONS #235): a hold on one intent's evidence, set by a person; held
//   evidence is never purged, and its files carry a legal hold. At most one active hold per intent.
//   Rows are never deleted; the fixed columns never change; `released_at` / `released_by` and
//   `release_applied_at` are set once; `applied_at` only moves forward (trigger `SDA16`).
// - `evidence_packs.retention_hold` stays unused: holds are per intent, in `evidence_holds`, so an
//   intent without a pack (cancelled before G8) can be held too. No UPDATE grant on it.
import { defineMigration } from './define.js';

const PACK_COLUMNS = `X.id, X.tenant_id, X.intent_id, X.version, X.content_sha256, X.manifest_uri,
           X.manifest_sha256, X.manifest_size_bytes, X.markdown_uri, X.markdown_sha256,
           X.markdown_size_bytes, X.locale, X.disclosure_format, X.item_count,
           X.built_by, X.created_at, X.release_sha256`;

const packsFixed = (extra: string) => `CREATE OR REPLACE FUNCTION evidence_packs_fixed()
       RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
     BEGIN
       IF (${PACK_COLUMNS.replaceAll('X.', 'NEW.')})
          IS DISTINCT FROM
          (${PACK_COLUMNS.replaceAll('X.', 'OLD.')}) THEN
         RAISE EXCEPTION 'evidence pack %: only sealed_at, retention_hold and purged_at change', OLD.id
           USING ERRCODE = 'SDA14';
       END IF;
       IF OLD.sealed_at IS NOT NULL AND NEW.sealed_at IS DISTINCT FROM OLD.sealed_at THEN
         RAISE EXCEPTION 'evidence pack %: sealed_at is set once', OLD.id USING ERRCODE = 'SDA14';
       END IF;
       IF OLD.purged_at IS NOT NULL AND NEW.purged_at IS DISTINCT FROM OLD.purged_at THEN
         RAISE EXCEPTION 'evidence pack %: purged_at is set once', OLD.id USING ERRCODE = 'SDA14';
       END IF;${extra}
       RETURN NEW;
     END $$`;

const PACK_LOCK_RULE = `
       IF OLD.lock_extended_until IS NOT NULL
          AND (NEW.lock_extended_until IS NULL OR NEW.lock_extended_until < OLD.lock_extended_until) THEN
         RAISE EXCEPTION 'evidence pack %: lock_extended_until only grows', OLD.id
           USING ERRCODE = 'SDA14';
       END IF;`;

export const migration0023Retention = defineMigration({
  up: [
    // Evidence items: only purged_at (once) and lock_extended_until (growing) change.
    `ALTER TABLE evidence_items ADD COLUMN lock_extended_until timestamptz`,
    `CREATE FUNCTION evidence_items_fixed() RETURNS trigger
       LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
     BEGIN
       IF (NEW.id, NEW.tenant_id, NEW.intent_id, NEW.run_id, NEW.kind, NEW.storage_uri, NEW.sha256,
           NEW.size_bytes, NEW.created_at)
          IS DISTINCT FROM
          (OLD.id, OLD.tenant_id, OLD.intent_id, OLD.run_id, OLD.kind, OLD.storage_uri, OLD.sha256,
           OLD.size_bytes, OLD.created_at) THEN
         RAISE EXCEPTION 'evidence item %: only purged_at and lock_extended_until change', OLD.id
           USING ERRCODE = 'SDA15';
       END IF;
       IF OLD.purged_at IS NOT NULL AND NEW.purged_at IS DISTINCT FROM OLD.purged_at THEN
         RAISE EXCEPTION 'evidence item %: purged_at is set once', OLD.id USING ERRCODE = 'SDA15';
       END IF;
       IF OLD.lock_extended_until IS NOT NULL
          AND (NEW.lock_extended_until IS NULL OR NEW.lock_extended_until < OLD.lock_extended_until) THEN
         RAISE EXCEPTION 'evidence item %: lock_extended_until only grows', OLD.id
           USING ERRCODE = 'SDA15';
       END IF;
       RETURN NEW;
     END $$`,
    `CREATE TRIGGER evidence_items_fixed BEFORE UPDATE ON evidence_items
       FOR EACH ROW EXECUTE FUNCTION evidence_items_fixed()`,
    `CREATE TRIGGER evidence_items_no_delete BEFORE DELETE ON evidence_items
       FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`,
    `CREATE TRIGGER evidence_items_no_truncate BEFORE TRUNCATE ON evidence_items
       FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()`,
    `GRANT UPDATE (purged_at, lock_extended_until) ON evidence_items TO platform_app`,
    // Evidence packs: the same two columns.
    `ALTER TABLE evidence_packs ADD COLUMN lock_extended_until timestamptz`,
    packsFixed(PACK_LOCK_RULE),
    `GRANT UPDATE (purged_at, lock_extended_until) ON evidence_packs TO platform_app`,
    // Holds (QUESTIONS #235).
    `CREATE TABLE evidence_holds (
       id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id           uuid NOT NULL,
       intent_id           uuid NOT NULL,
       held_by             uuid NOT NULL,
       reason_ref          text CHECK (
                             char_length(reason_ref) <= 512 AND reason_ref ~ '^https://[^\\s]+$'),
       applied_at          timestamptz,
       released_at         timestamptz,
       released_by         uuid,
       release_applied_at  timestamptz,
       created_at          timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT evidence_holds_tenant_id_id_key UNIQUE (tenant_id, id),
       CONSTRAINT evidence_holds_released CHECK ((released_at IS NULL) = (released_by IS NULL)),
       CONSTRAINT evidence_holds_release_applied CHECK (
         release_applied_at IS NULL OR released_at IS NOT NULL),
       CONSTRAINT evidence_holds_intent_fkey FOREIGN KEY (tenant_id, intent_id)
         REFERENCES intents (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT evidence_holds_held_by_fkey FOREIGN KEY (tenant_id, held_by)
         REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT evidence_holds_released_by_fkey FOREIGN KEY (tenant_id, released_by)
         REFERENCES users (tenant_id, id) ON DELETE RESTRICT
     )`,
    `CREATE UNIQUE INDEX evidence_holds_one_active ON evidence_holds (tenant_id, intent_id)
       WHERE released_at IS NULL`,
    `CREATE INDEX evidence_holds_tenant_id_intent_id_idx ON evidence_holds (tenant_id, intent_id)`,
    `CREATE FUNCTION evidence_holds_fixed() RETURNS trigger
       LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
     BEGIN
       IF (NEW.id, NEW.tenant_id, NEW.intent_id, NEW.held_by, NEW.reason_ref, NEW.created_at)
          IS DISTINCT FROM
          (OLD.id, OLD.tenant_id, OLD.intent_id, OLD.held_by, OLD.reason_ref, OLD.created_at) THEN
         RAISE EXCEPTION 'evidence hold %: only the apply and release columns change', OLD.id
           USING ERRCODE = 'SDA16';
       END IF;
       IF OLD.released_at IS NOT NULL
          AND (NEW.released_at IS DISTINCT FROM OLD.released_at
               OR NEW.released_by IS DISTINCT FROM OLD.released_by) THEN
         RAISE EXCEPTION 'evidence hold %: released once', OLD.id USING ERRCODE = 'SDA16';
       END IF;
       IF OLD.release_applied_at IS NOT NULL
          AND NEW.release_applied_at IS DISTINCT FROM OLD.release_applied_at THEN
         RAISE EXCEPTION 'evidence hold %: release applied once', OLD.id USING ERRCODE = 'SDA16';
       END IF;
       IF OLD.applied_at IS NOT NULL
          AND (NEW.applied_at IS NULL OR NEW.applied_at < OLD.applied_at) THEN
         RAISE EXCEPTION 'evidence hold %: applied_at only moves forward', OLD.id
           USING ERRCODE = 'SDA16';
       END IF;
       RETURN NEW;
     END $$`,
    `CREATE TRIGGER evidence_holds_fixed BEFORE UPDATE ON evidence_holds
       FOR EACH ROW EXECUTE FUNCTION evidence_holds_fixed()`,
    `CREATE TRIGGER evidence_holds_no_delete BEFORE DELETE ON evidence_holds
       FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`,
    `CREATE TRIGGER evidence_holds_no_truncate BEFORE TRUNCATE ON evidence_holds
       FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()`,
    `REVOKE ALL ON evidence_holds FROM PUBLIC`,
    `GRANT SELECT, INSERT ON evidence_holds TO platform_app`,
    `GRANT UPDATE (applied_at, released_at, released_by, release_applied_at) ON evidence_holds
       TO platform_app`,
  ],
  // Development only (ADR-M09).
  down: [
    `DROP TABLE evidence_holds`,
    `DROP FUNCTION evidence_holds_fixed()`,
    `REVOKE UPDATE (purged_at, lock_extended_until) ON evidence_packs FROM platform_app`,
    packsFixed(''),
    `ALTER TABLE evidence_packs DROP COLUMN lock_extended_until`,
    `REVOKE UPDATE (purged_at, lock_extended_until) ON evidence_items FROM platform_app`,
    `DROP TRIGGER evidence_items_no_truncate ON evidence_items`,
    `DROP TRIGGER evidence_items_no_delete ON evidence_items`,
    `DROP TRIGGER evidence_items_fixed ON evidence_items`,
    `DROP FUNCTION evidence_items_fixed()`,
    `ALTER TABLE evidence_items DROP COLUMN lock_extended_until`,
  ],
});
