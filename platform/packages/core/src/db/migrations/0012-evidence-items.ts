// Migration 0012: evidence items (design/D-05 section 6.6, version 1.17; D-08 C06 session 2b;
// design/ADR-M33 §2.9). Rules for every migration: see the header of 0001-tenancy.ts and ADR-M09.
//
// - One row per evidence file in SeaweedFS: the kind, the storage URI, the SHA-256 and the size.
//   The file itself (client code, for example an L1 proposal patch) never enters the database.
// - Written once: `SELECT, INSERT` for `platform_app`. `purged_at` gets its UPDATE grant with the
//   purge job (E05, D-05 section 10.1), which also keeps the row and the hash.
// - One row per URI per tenant: evidence is never overwritten (the store refuses a taken path).
import { defineMigration } from './define.js';

const KINDS = `('spec', 'plan', 'proposal', 'diff', 'ci_result', 'test_report', 'scan_report',
  'review', 'cost_summary', 'disclosure_note')`;

export const migration0012EvidenceItems = defineMigration({
  up: [
    `CREATE TABLE evidence_items (
       id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id    uuid NOT NULL,
       intent_id    uuid NOT NULL,
       run_id       uuid,
       kind         text NOT NULL CHECK (kind IN ${KINDS}),
       storage_uri  text NOT NULL CHECK (
                      char_length(storage_uri) <= 700
                      AND storage_uri ~ '^s3://[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]/[A-Za-z0-9._/-]+$'
                      AND storage_uri !~ '/\\.\\.?(/|$)'),
       sha256       char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
       size_bytes   bigint NOT NULL CHECK (size_bytes >= 0),
       purged_at    timestamptz,
       created_at   timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT evidence_items_tenant_id_id_key UNIQUE (tenant_id, id),
       CONSTRAINT evidence_items_tenant_id_storage_uri_key UNIQUE (tenant_id, storage_uri),
       CONSTRAINT evidence_items_intent_fkey FOREIGN KEY (tenant_id, intent_id)
         REFERENCES intents (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT evidence_items_run_fkey FOREIGN KEY (tenant_id, run_id)
         REFERENCES runs (tenant_id, id) ON DELETE RESTRICT
     )`,
    `CREATE INDEX evidence_items_tenant_id_intent_id_idx ON evidence_items (tenant_id, intent_id)`,
    `REVOKE ALL ON evidence_items FROM PUBLIC`,
    `GRANT SELECT, INSERT ON evidence_items TO platform_app`,
  ],
  down: [`DROP TABLE evidence_items`],
});
