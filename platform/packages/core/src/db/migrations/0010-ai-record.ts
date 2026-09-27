// Migration 0010: the project AI record as built in B12 (design/D-05 section 6.1, D-08 B12,
// design/ADR-M32). Rules for every migration: see the header of 0001-tenancy.ts and ADR-M09.
//
// - Codes only (QUESTIONS.md #104): the free-text columns `confirmed_by` (a client contact: personal
//   data) and `allowed_tools_locations` are dropped. The human record (contact, tools, locations,
//   special conditions) stays in the document `record_ref` links to (template T7:
//   `docs/project/ai-record.md`, or a document link), where it can be edited or deleted.
// - `record_sha256`: SHA-256 of the RFC 8785 canonical JSON of the coded record, computed by the
//   platform (ADR-M32 §2.2).
// - The fixed rules of handbook Chapter 2 (ADR-M32 §3) are repeated as CHECK constraints:
//   `prohibited` is never allowed; AI use `no` allows no `client_*` class; while consent is unknown
//   (`confirmed_at` empty) `client_confidential` is not allowed (Rule 3); a confirmed record links
//   the written answer.
// - `project_ai_record_versions` keeps every version (append-only, codes only). A trigger on
//   `project_ai_records` writes it, so no save can skip the history; the versions go up by one.
//
// No row exists outside tests when this runs (no project is onboarded before B13); the NOT NULL
// on `record_sha256` makes the migration fail loudly if one does.
import { defineMigration } from './define.js';

const HEX64 = `~ '^[0-9a-f]{64}$'`;
// Same format as `gate_decisions.reason_ref` (ADR-M20).
const HTTPS_REF = `~ '^https://[^[:space:]]+$' AND length(record_ref) <= 512`;
const CLIENT_CLASSES = `ARRAY['client_confidential', 'client_restricted']::data_class[]`;

// The coded record, the same columns in both tables.
const RULES = [
  `CHECK (array_position(allowed_data_classes, NULL) IS NULL)`,
  `CHECK (NOT ('prohibited' = ANY (allowed_data_classes)))`,
  `CHECK (ai_allowed <> 'no' OR NOT (allowed_data_classes && ${CLIENT_CLASSES}))`,
  `CHECK (confirmed_at IS NOT NULL OR NOT ('client_confidential' = ANY (allowed_data_classes)))`,
  `CHECK (confirmed_at IS NULL OR record_ref IS NOT NULL)`,
];

export const migration0010AiRecord = defineMigration({
  up: [
    `ALTER TABLE project_ai_records
       DROP COLUMN confirmed_by,
       DROP COLUMN allowed_tools_locations,
       ADD COLUMN record_ref text CHECK (record_ref ${HTTPS_REF}),
       ADD COLUMN record_sha256 char(64) CHECK (record_sha256 ${HEX64})`,
    `ALTER TABLE project_ai_records ALTER COLUMN record_sha256 SET NOT NULL`,
    ...RULES.map(
      (rule, i) =>
        `ALTER TABLE project_ai_records ADD CONSTRAINT project_ai_records_rule_${String(i + 1)} ${rule}`,
    ),
    // `project_ai_records` has no UNIQUE (tenant_id, project_id) yet: the history refers to it.
    `ALTER TABLE project_ai_records ADD CONSTRAINT project_ai_records_tenant_id_project_id_key
       UNIQUE (tenant_id, project_id)`,
    `GRANT UPDATE (record_ref, record_sha256) ON project_ai_records TO platform_app`,

    `CREATE TABLE project_ai_record_versions (
       tenant_id            uuid NOT NULL,
       project_id           uuid NOT NULL,
       version              integer NOT NULL CHECK (version >= 1),
       ai_allowed           text NOT NULL CHECK (ai_allowed IN ('no', 'yes', 'yes_with_conditions')),
       allowed_data_classes data_class[] NOT NULL,
       prod_logs_allowed    text NOT NULL CHECK (prod_logs_allowed IN ('no', 'yes_masked')),
       disclosure_format    text NOT NULL CHECK (disclosure_format IN ('client_format', 'standard_note')),
       confirmed_at         date,
       record_ref           text CHECK (record_ref ${HTTPS_REF}),
       record_sha256        char(64) NOT NULL CHECK (record_sha256 ${HEX64}),
       updated_by           uuid NOT NULL,
       created_at           timestamptz NOT NULL DEFAULT now(),
       PRIMARY KEY (tenant_id, project_id, version),
       CONSTRAINT project_ai_record_versions_record_fkey FOREIGN KEY (tenant_id, project_id)
         REFERENCES project_ai_records (tenant_id, project_id) ON DELETE RESTRICT,
       CONSTRAINT project_ai_record_versions_updated_by_fkey FOREIGN KEY (tenant_id, updated_by)
         REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
       ${RULES.map((rule, i) => `CONSTRAINT project_ai_record_versions_rule_${String(i + 1)} ${rule}`).join(',\n       ')}
     )`,
    `CREATE TRIGGER project_ai_record_versions_no_update_delete
       BEFORE UPDATE OR DELETE ON project_ai_record_versions
       FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`,
    `CREATE TRIGGER project_ai_record_versions_no_truncate BEFORE TRUNCATE ON project_ai_record_versions
       FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()`,

    // Every insert or update of the record appends its version: the history cannot be skipped.
    `CREATE FUNCTION project_ai_records_version() RETURNS trigger
       LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
     BEGIN
       IF TG_OP = 'INSERT' AND NEW.version <> 1 THEN
         RAISE EXCEPTION 'project AI record %: the first version is 1', NEW.project_id
           USING ERRCODE = 'check_violation';
       END IF;
       IF TG_OP = 'UPDATE' AND (NEW.version <> OLD.version + 1 OR NEW.project_id <> OLD.project_id) THEN
         RAISE EXCEPTION 'project AI record %: every change is the next version', OLD.project_id
           USING ERRCODE = 'check_violation';
       END IF;
       INSERT INTO project_ai_record_versions (tenant_id, project_id, version, ai_allowed,
         allowed_data_classes, prod_logs_allowed, disclosure_format, confirmed_at, record_ref,
         record_sha256, updated_by)
       VALUES (NEW.tenant_id, NEW.project_id, NEW.version, NEW.ai_allowed, NEW.allowed_data_classes,
         NEW.prod_logs_allowed, NEW.disclosure_format, NEW.confirmed_at, NEW.record_ref,
         NEW.record_sha256, NEW.updated_by);
       RETURN NEW;
     END $$`,
    `CREATE TRIGGER project_ai_records_version AFTER INSERT OR UPDATE ON project_ai_records
       FOR EACH ROW EXECUTE FUNCTION project_ai_records_version()`,

    `REVOKE ALL ON project_ai_record_versions FROM PUBLIC`,
    `GRANT SELECT, INSERT ON project_ai_record_versions TO platform_app`,
  ],
  down: [
    `DROP TRIGGER project_ai_records_version ON project_ai_records`,
    `DROP FUNCTION project_ai_records_version()`,
    `DROP TABLE project_ai_record_versions`,
    ...RULES.map(
      (_, i) =>
        `ALTER TABLE project_ai_records DROP CONSTRAINT project_ai_records_rule_${String(i + 1)}`,
    ),
    `ALTER TABLE project_ai_records DROP CONSTRAINT project_ai_records_tenant_id_project_id_key`,
    `ALTER TABLE project_ai_records DROP COLUMN record_ref, DROP COLUMN record_sha256,
       ADD COLUMN allowed_tools_locations text, ADD COLUMN confirmed_by text`,
    `GRANT UPDATE (allowed_tools_locations, confirmed_by) ON project_ai_records TO platform_app`,
  ],
});
