// Migration 0022: gate G8 (design/D-05 section 6.6, version 1.31; D-08 E03; design/ADR-M49;
// QUESTIONS #220–#222). Rules for every migration: see the header of 0001-tenancy.ts and
// design/ADR-M09.
//
// - `evidence_packs.release_sha256`: the SHA-256 of the pack's manifest content without the G8
//   parts (G8 gate decisions and G8 escalations). G8 approvals are bound to it (ADR-M49 §2.2), so a
//   new G8 approval makes a new pack version without voiding the other approvals. Null for packs
//   built before E03; every new build sets it. Fixed once written (trigger `SDA14`, extended).
// - `GRANT UPDATE (sealed_at)`: G8 seals one version (E03). The trigger keeps it set once, and the
//   index `evidence_packs_one_sealed` keeps one sealed version per intent.
import { defineMigration } from './define.js';

const SHA = `'^[0-9a-f]{64}$'`;

const fixedFunction = (columns: string) => `CREATE OR REPLACE FUNCTION evidence_packs_fixed()
       RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
     BEGIN
       IF (${columns.replaceAll('X.', 'NEW.')})
          IS DISTINCT FROM
          (${columns.replaceAll('X.', 'OLD.')}) THEN
         RAISE EXCEPTION 'evidence pack %: only sealed_at, retention_hold and purged_at change', OLD.id
           USING ERRCODE = 'SDA14';
       END IF;
       IF OLD.sealed_at IS NOT NULL AND NEW.sealed_at IS DISTINCT FROM OLD.sealed_at THEN
         RAISE EXCEPTION 'evidence pack %: sealed_at is set once', OLD.id USING ERRCODE = 'SDA14';
       END IF;
       IF OLD.purged_at IS NOT NULL AND NEW.purged_at IS DISTINCT FROM OLD.purged_at THEN
         RAISE EXCEPTION 'evidence pack %: purged_at is set once', OLD.id USING ERRCODE = 'SDA14';
       END IF;
       RETURN NEW;
     END $$`;

const BASE_COLUMNS = `X.id, X.tenant_id, X.intent_id, X.version, X.content_sha256, X.manifest_uri,
           X.manifest_sha256, X.manifest_size_bytes, X.markdown_uri, X.markdown_sha256,
           X.markdown_size_bytes, X.locale, X.disclosure_format, X.item_count,
           X.built_by, X.created_at`;

export const migration0022GateG8 = defineMigration({
  up: [
    `ALTER TABLE evidence_packs ADD COLUMN release_sha256 char(64)
       CHECK (release_sha256 ~ ${SHA})`,
    fixedFunction(`${BASE_COLUMNS}, X.release_sha256`),
    `GRANT UPDATE (sealed_at) ON evidence_packs TO platform_app`,
  ],
  // Development only (ADR-M09).
  down: [
    `REVOKE UPDATE (sealed_at) ON evidence_packs FROM platform_app`,
    fixedFunction(BASE_COLUMNS),
    `ALTER TABLE evidence_packs DROP COLUMN release_sha256`,
  ],
});
