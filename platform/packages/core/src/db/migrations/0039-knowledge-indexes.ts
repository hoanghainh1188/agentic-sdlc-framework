// Migration 0039: the platform's record of the index of a project's documents (design/D-05 section
// 6.1, version 1.58; D-08 X04 PR 3a; design/ADR-M89 §2.2). Rules for every migration: see the
// header of 0001-tenancy.ts and design/ADR-M09. Migrations 0001–0038 are merged and never edited.
//
// - `knowledge_indexes`: one row per index built in `knowledge-db`, at most one ready (not purged)
//   per (tenant, project, base commit, model). Codes, IDs, hashes, counts and dates only: the document paths and texts live
//   in `knowledge-db`, where retention deletes them. Only `last_used_at` and `purged_at` change.
// - `knowledge_index_uses` (append-only): which run and intent used which index version, so the
//   retention pass knows when every user of an index is finished (ADR-M89 §2.4).
//
// Custom SQLSTATE (translated in errors.ts):
//   SDA26  a knowledge index's fixed columns changed, or `purged_at` set twice or moved back
import { defineMigration } from './define.js';

export const migration0039KnowledgeIndexes = defineMigration({
  up: [
    `CREATE TABLE knowledge_indexes (
       id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id    uuid NOT NULL,
       project_id   uuid NOT NULL,
       base_sha     char(40) NOT NULL CHECK (base_sha ~ '^[0-9a-f]{40}$'),
       model        text NOT NULL CHECK (model ~ '^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$'),
       documents    integer NOT NULL CHECK (documents >= 0),
       chunks       integer NOT NULL CHECK (chunks >= 0),
       bytes        bigint NOT NULL CHECK (bytes >= 0),
       created_at   timestamptz NOT NULL DEFAULT now(),
       last_used_at timestamptz NOT NULL DEFAULT now(),
       purged_at    timestamptz,
       CONSTRAINT knowledge_indexes_tenant_id_id_key UNIQUE (tenant_id, id),
       CONSTRAINT knowledge_indexes_project_fkey FOREIGN KEY (tenant_id, project_id)
         REFERENCES projects (tenant_id, id) ON DELETE RESTRICT
     )`,
    // One ready index per commit and model; a purged one may be built again.
    `CREATE UNIQUE INDEX knowledge_indexes_one_ready_per_commit
       ON knowledge_indexes (tenant_id, project_id, base_sha, model) WHERE purged_at IS NULL`,
    `CREATE INDEX knowledge_indexes_project_idx ON knowledge_indexes (tenant_id, project_id)
       WHERE purged_at IS NULL`,
    `CREATE FUNCTION knowledge_indexes_guard() RETURNS trigger
       LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
     BEGIN
       IF (NEW.id, NEW.tenant_id, NEW.project_id, NEW.base_sha, NEW.model, NEW.documents,
           NEW.chunks, NEW.bytes, NEW.created_at)
          IS DISTINCT FROM
          (OLD.id, OLD.tenant_id, OLD.project_id, OLD.base_sha, OLD.model, OLD.documents,
           OLD.chunks, OLD.bytes, OLD.created_at) THEN
         RAISE EXCEPTION 'knowledge index %: only its use and purge dates change', OLD.id
           USING ERRCODE = 'SDA26';
       END IF;
       IF OLD.purged_at IS NOT NULL AND NEW.purged_at IS DISTINCT FROM OLD.purged_at THEN
         RAISE EXCEPTION 'knowledge index %: purged once', OLD.id USING ERRCODE = 'SDA26';
       END IF;
       IF NEW.last_used_at < OLD.last_used_at THEN
         RAISE EXCEPTION 'knowledge index %: the use date never goes back', OLD.id
           USING ERRCODE = 'SDA26';
       END IF;
       RETURN NEW;
     END $$`,
    `CREATE TRIGGER knowledge_indexes_guard BEFORE UPDATE ON knowledge_indexes
       FOR EACH ROW EXECUTE FUNCTION knowledge_indexes_guard()`,
    `REVOKE ALL ON knowledge_indexes FROM PUBLIC`,
    `GRANT SELECT, INSERT ON knowledge_indexes TO platform_app`,
    `GRANT UPDATE (last_used_at, purged_at) ON knowledge_indexes TO platform_app`,

    `CREATE TABLE knowledge_index_uses (
       id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id  uuid NOT NULL,
       index_id   uuid NOT NULL,
       run_id     uuid NOT NULL,
       intent_id  uuid NOT NULL,
       created_at timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT knowledge_index_uses_one_per_run UNIQUE (tenant_id, index_id, run_id),
       CONSTRAINT knowledge_index_uses_index_fkey FOREIGN KEY (tenant_id, index_id)
         REFERENCES knowledge_indexes (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT knowledge_index_uses_run_fkey FOREIGN KEY (tenant_id, run_id)
         REFERENCES runs (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT knowledge_index_uses_intent_fkey FOREIGN KEY (tenant_id, intent_id)
         REFERENCES intents (tenant_id, id) ON DELETE RESTRICT
     )`,
    `CREATE INDEX knowledge_index_uses_index_idx ON knowledge_index_uses (tenant_id, index_id)`,
    `CREATE TRIGGER knowledge_index_uses_no_update_delete BEFORE UPDATE OR DELETE
       ON knowledge_index_uses FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`,
    `CREATE TRIGGER knowledge_index_uses_no_truncate BEFORE TRUNCATE ON knowledge_index_uses
       FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()`,
    `REVOKE ALL ON knowledge_index_uses FROM PUBLIC`,
    `GRANT SELECT, INSERT ON knowledge_index_uses TO platform_app`,
  ],
  // Development only (ADR-M09).
  down: [
    `DROP TABLE knowledge_index_uses`,
    `DROP TABLE knowledge_indexes`,
    `DROP FUNCTION knowledge_indexes_guard()`,
  ],
});
