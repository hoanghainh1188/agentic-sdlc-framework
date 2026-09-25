// Migration 0002: append-only audit log with a per-tenant hash chain (design/D-05 sections 6.7
// and 7, D-08 A07), and the role_bindings revocation guard (design/QUESTIONS.md #12).
// Rules for every migration: see the header of 0001-tenancy.ts and design/ADR-M09.
//
// Errors raised by the triggers use SQLSTATE codes of our own (class `SD`), so the data access
// layer can map them to stable `DbError` codes (errors.ts):
//   SDA01  append-only table: UPDATE, DELETE or TRUNCATE refused
//   SDA02  audit chain link broken on insert (wrong seq or prev_hash)
//   SDA03  role binding already revoked: it can never change again
import { defineMigration } from './define.js';

const HEX64 = `~ '^[0-9a-f]{64}$'`;
const GENESIS = `repeat('0', 64)`;

export const migration0002AuditLog = defineMigration({
  up: [
    `CREATE TYPE actor_type AS ENUM ('human', 'system', 'agent')`,

    // Shared by every append-only table (D-05 D3): audit_log now; gate_decisions, run_events and
    // cost_records attach it when their tasks create them (B02, C02, C03).
    `CREATE FUNCTION forbid_mutation() RETURNS trigger
       LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
     BEGIN
       RAISE EXCEPTION 'append-only table: % not allowed on %', TG_OP, TG_TABLE_NAME
         USING ERRCODE = 'SDA01';
     END $$`,

    `CREATE TABLE audit_log (
       id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
       tenant_id    uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
       seq          bigint NOT NULL CHECK (seq >= 1),
       hash_version smallint NOT NULL CHECK (hash_version = 1),
       actor_type   actor_type NOT NULL,
       actor_id     uuid,
       action       text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$'),
       entity_type  text CHECK (entity_type ~ '^[a-z][a-z0-9_]*$'),
       entity_id    uuid,
       payload      jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
       prev_hash    char(64) NOT NULL CHECK (prev_hash ${HEX64}),
       hash         char(64) NOT NULL CHECK (hash ${HEX64}),
       occurred_at  timestamptz NOT NULL,
       created_at   timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT audit_log_tenant_id_seq_key UNIQUE (tenant_id, seq),
       CONSTRAINT audit_log_genesis CHECK (seq > 1 OR prev_hash = ${GENESIS}),
       CONSTRAINT audit_log_entity_pair CHECK ((entity_type IS NULL) = (entity_id IS NULL))
     )`,

    `CREATE TRIGGER audit_log_no_update_delete BEFORE UPDATE OR DELETE ON audit_log
       FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`,
    // Row triggers do not fire on TRUNCATE.
    `CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
       FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()`,

    // Chain link check. The hash itself is computed by the application (RFC 8785 canonical JSON);
    // this trigger refuses a row that does not follow the tenant's last row, so a writer that
    // skipped the per-tenant advisory lock cannot create a gap or a fork.
    `CREATE FUNCTION audit_log_check_link() RETURNS trigger
       LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
     DECLARE
       last_seq  bigint;
       last_hash char(64);
     BEGIN
       SELECT seq, hash INTO last_seq, last_hash
         FROM audit_log WHERE tenant_id = NEW.tenant_id ORDER BY seq DESC LIMIT 1;
       IF NOT FOUND THEN
         last_seq := 0;
         last_hash := ${GENESIS};
       END IF;
       IF NEW.seq <> last_seq + 1 OR NEW.prev_hash <> last_hash THEN
         RAISE EXCEPTION 'audit chain: seq % does not follow seq % of tenant %',
           NEW.seq, last_seq, NEW.tenant_id USING ERRCODE = 'SDA02';
       END IF;
       RETURN NEW;
     END $$`,
    `CREATE TRIGGER audit_log_check_link BEFORE INSERT ON audit_log
       FOR EACH ROW EXECUTE FUNCTION audit_log_check_link()`,

    `REVOKE ALL ON audit_log FROM PUBLIC`,
    // Append-only: SELECT and INSERT only (ADR-M09 section 2.3). The identity column needs no
    // sequence grant.
    `GRANT SELECT, INSERT ON audit_log TO platform_app`,

    // QUESTIONS #12: once revoked, a role binding never changes again (it cannot be reactivated).
    `CREATE FUNCTION role_bindings_revocation_is_final() RETURNS trigger
       LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
     BEGIN
       IF OLD.revoked_at IS NOT NULL THEN
         RAISE EXCEPTION 'role binding % is revoked and cannot change', OLD.id
           USING ERRCODE = 'SDA03';
       END IF;
       RETURN NEW;
     END $$`,
    `CREATE TRIGGER role_bindings_revocation_is_final BEFORE UPDATE ON role_bindings
       FOR EACH ROW EXECUTE FUNCTION role_bindings_revocation_is_final()`,
  ],
  down: [
    `DROP TRIGGER role_bindings_revocation_is_final ON role_bindings`,
    `DROP FUNCTION role_bindings_revocation_is_final()`,
    `DROP TABLE audit_log`,
    `DROP FUNCTION audit_log_check_link()`,
    `DROP FUNCTION forbid_mutation()`,
    `DROP TYPE actor_type`,
  ],
});
