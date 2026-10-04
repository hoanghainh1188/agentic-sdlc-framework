// Migration 0021: evidence packs (design/D-05 section 6.6, version 1.30; D-08 E02; D-02 FR-40,
// FR-42, FR-43; design/ADR-M48; QUESTIONS #215). Rules for every migration: see the header of
// 0001-tenancy.ts and design/ADR-M09.
//
// - One row per build of an intent's Evidence Pack (QUESTIONS #215): a numbered version, never
//   changed. The files (a JSON manifest and one Markdown file) are in SeaweedFS under
//   `evidence/packs/<tenant>/<intent>/<pack id>/`; the row holds their URIs, SHA-256 and sizes.
// - `content_sha256` is the hash of the manifest content without the build's own fields (time,
//   builder, version): a build whose content equals the latest version's returns that version.
// - At most one sealed version per intent (E03 seals it at G8). Once set, `sealed_at` and
//   `purged_at` never change; `retention_hold` may (E05). Every other column is fixed (trigger,
//   `SDA14`); rows are never deleted.
// - Grants: SELECT and INSERT now. E03 (`sealed_at`) and E05 (`retention_hold`, `purged_at`) add
//   their column grants.
import { defineMigration } from './define.js';

const URI = `'^s3://[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]/[A-Za-z0-9._/-]+$'`;
const SHA = `'^[0-9a-f]{64}$'`;

export const migration0021EvidencePacks = defineMigration({
  up: [
    `CREATE TABLE evidence_packs (
       id                  uuid PRIMARY KEY,
       tenant_id           uuid NOT NULL,
       intent_id           uuid NOT NULL,
       version             integer NOT NULL CHECK (version >= 1),
       content_sha256      char(64) NOT NULL CHECK (content_sha256 ~ ${SHA}),
       manifest_uri        text NOT NULL CHECK (
                             char_length(manifest_uri) <= 700 AND manifest_uri ~ ${URI}
                             AND manifest_uri !~ '/\\.\\.?(/|$)'),
       manifest_sha256     char(64) NOT NULL CHECK (manifest_sha256 ~ ${SHA}),
       manifest_size_bytes bigint NOT NULL CHECK (manifest_size_bytes >= 0),
       markdown_uri        text NOT NULL CHECK (
                             char_length(markdown_uri) <= 700 AND markdown_uri ~ ${URI}
                             AND markdown_uri !~ '/\\.\\.?(/|$)'),
       markdown_sha256     char(64) NOT NULL CHECK (markdown_sha256 ~ ${SHA}),
       markdown_size_bytes bigint NOT NULL CHECK (markdown_size_bytes >= 0),
       locale              text NOT NULL CHECK (locale ~ '^[a-z]{2}(-[A-Z]{2})?$'),
       disclosure_format   text NOT NULL CHECK (disclosure_format IN ('client_format', 'standard_note')),
       item_count          integer NOT NULL CHECK (item_count >= 0),
       built_by            uuid,
       sealed_at           timestamptz,
       retention_hold      boolean NOT NULL DEFAULT false,
       purged_at           timestamptz,
       created_at          timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT evidence_packs_tenant_id_id_key UNIQUE (tenant_id, id),
       CONSTRAINT evidence_packs_version_key UNIQUE (tenant_id, intent_id, version),
       CONSTRAINT evidence_packs_manifest_uri_key UNIQUE (tenant_id, manifest_uri),
       CONSTRAINT evidence_packs_markdown_uri_key UNIQUE (tenant_id, markdown_uri),
       CONSTRAINT evidence_packs_intent_fkey FOREIGN KEY (tenant_id, intent_id)
         REFERENCES intents (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT evidence_packs_built_by_fkey FOREIGN KEY (tenant_id, built_by)
         REFERENCES users (tenant_id, id) ON DELETE RESTRICT
     )`,
    `CREATE UNIQUE INDEX evidence_packs_one_sealed ON evidence_packs (tenant_id, intent_id)
       WHERE sealed_at IS NOT NULL`,
    `CREATE FUNCTION evidence_packs_fixed() RETURNS trigger
       LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
     BEGIN
       IF (NEW.id, NEW.tenant_id, NEW.intent_id, NEW.version, NEW.content_sha256, NEW.manifest_uri,
           NEW.manifest_sha256, NEW.manifest_size_bytes, NEW.markdown_uri, NEW.markdown_sha256,
           NEW.markdown_size_bytes, NEW.locale, NEW.disclosure_format, NEW.item_count,
           NEW.built_by, NEW.created_at)
          IS DISTINCT FROM
          (OLD.id, OLD.tenant_id, OLD.intent_id, OLD.version, OLD.content_sha256, OLD.manifest_uri,
           OLD.manifest_sha256, OLD.manifest_size_bytes, OLD.markdown_uri, OLD.markdown_sha256,
           OLD.markdown_size_bytes, OLD.locale, OLD.disclosure_format, OLD.item_count,
           OLD.built_by, OLD.created_at) THEN
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
     END $$`,
    `CREATE TRIGGER evidence_packs_fixed BEFORE UPDATE ON evidence_packs
       FOR EACH ROW EXECUTE FUNCTION evidence_packs_fixed()`,
    `CREATE TRIGGER evidence_packs_no_delete BEFORE DELETE ON evidence_packs
       FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`,
    `CREATE TRIGGER evidence_packs_no_truncate BEFORE TRUNCATE ON evidence_packs
       FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()`,
    `REVOKE ALL ON evidence_packs FROM PUBLIC`,
    `GRANT SELECT, INSERT ON evidence_packs TO platform_app`,
  ],
  // Development only (ADR-M09).
  down: [`DROP TABLE evidence_packs`, `DROP FUNCTION evidence_packs_fixed()`],
});
