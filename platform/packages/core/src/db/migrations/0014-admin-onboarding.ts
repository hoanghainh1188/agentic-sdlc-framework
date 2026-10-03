// Migration 0014: admin onboarding (design/D-05 sections 5 and 6.1, version 1.19; D-08 B13;
// design/ADR-M37; QUESTIONS #65, #95, #150). Rules for every migration: see the header of
// 0001-tenancy.ts and design/ADR-M09.
//
// - `tenant_role_bindings` (QUESTIONS #150, option A): tenant-level roles. One role for now,
//   `tenant_admin`: projects, users, identities, tokens, the agent register and `audit verify`.
//   Like `role_bindings`, a role is withdrawn by setting `revoked_at`, never deleted, and a revoked
//   row never changes again (SDA11).
// - `user_identities.unlinked_at` (D-08 B13 AC2, AC3): an identity is unlinked, never deleted. Only
//   linked identities are unique, so an account can be linked again (to the same or another user).
//   `external_id` must be the numeric account ID (QUESTIONS #45): a login can never be stored there.
//   An unlinked identity never changes again (SDA11).
// - `project_configs.override_sha256` (D-08 B13 AC8, QUESTIONS #95): SHA-256 of the stored YAML
//   text. When the effective `config_hash` no longer matches but this hash still does, only the
//   platform defaults changed (a new release); otherwise the stored YAML itself was changed.
//   Existing rows (tests only; no project is onboarded before B13) are filled from their YAML.
import { defineMigration } from './define.js';

const HEX64 = `~ '^[0-9a-f]{64}$'`;

export const migration0014AdminOnboarding = defineMigration({
  up: [
    `CREATE TYPE tenant_role AS ENUM ('tenant_admin')`,
    `CREATE TABLE tenant_role_bindings (
       id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id  uuid NOT NULL,
       user_id    uuid NOT NULL,
       role       tenant_role NOT NULL,
       revoked_at timestamptz,
       created_at timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT tenant_role_bindings_tenant_fkey FOREIGN KEY (tenant_id)
         REFERENCES tenants (id) ON DELETE RESTRICT,
       CONSTRAINT tenant_role_bindings_user_fkey FOREIGN KEY (tenant_id, user_id)
         REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT tenant_role_bindings_revoked_after_creation CHECK (revoked_at >= created_at)
     )`,
    // One active binding per person and role; revoked rows stay as history.
    `CREATE UNIQUE INDEX tenant_role_bindings_active_key
       ON tenant_role_bindings (tenant_id, user_id, role) WHERE revoked_at IS NULL`,
    `CREATE INDEX tenant_role_bindings_tenant_id_idx ON tenant_role_bindings (tenant_id)`,

    // A revoked tenant role or an unlinked identity is history: it never changes again.
    `CREATE FUNCTION withdrawal_is_final() RETURNS trigger
       LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
     BEGIN
       -- Nested: a column of one table must never be read on a row of the other.
       IF TG_TABLE_NAME = 'tenant_role_bindings' THEN
         IF OLD.revoked_at IS NOT NULL THEN
           RAISE EXCEPTION 'tenant role % is revoked and cannot change', OLD.id
             USING ERRCODE = 'SDA11';
         END IF;
       ELSIF TG_TABLE_NAME = 'user_identities' THEN
         IF OLD.unlinked_at IS NOT NULL THEN
           RAISE EXCEPTION 'identity % is unlinked and cannot change', OLD.id
             USING ERRCODE = 'SDA11';
         END IF;
       END IF;
       RETURN NEW;
     END $$`,
    `CREATE TRIGGER tenant_role_bindings_withdrawal_is_final BEFORE UPDATE ON tenant_role_bindings
       FOR EACH ROW EXECUTE FUNCTION withdrawal_is_final()`,

    `ALTER TABLE user_identities
       ADD COLUMN unlinked_at timestamptz,
       ADD CONSTRAINT user_identities_unlinked_after_creation CHECK (unlinked_at >= created_at),
       ADD CONSTRAINT user_identities_external_id_numeric CHECK (external_id ~ '^[1-9][0-9]{0,19}$'),
       ADD CONSTRAINT user_identities_external_login_length
         CHECK (length(external_login) BETWEEN 1 AND 100)`,
    `ALTER TABLE user_identities DROP CONSTRAINT user_identities_tenant_id_provider_external_id_key`,
    `CREATE UNIQUE INDEX user_identities_linked_key ON user_identities (tenant_id, provider, external_id)
       WHERE unlinked_at IS NULL`,
    `CREATE INDEX user_identities_tenant_id_user_id_idx ON user_identities (tenant_id, user_id)`,
    `CREATE TRIGGER user_identities_withdrawal_is_final BEFORE UPDATE ON user_identities
       FOR EACH ROW EXECUTE FUNCTION withdrawal_is_final()`,

    `ALTER TABLE project_configs ADD COLUMN override_sha256 char(64) CHECK (override_sha256 ${HEX64})`,
    `UPDATE project_configs SET override_sha256 = encode(sha256(convert_to(config_yaml, 'UTF8')), 'hex')`,
    `ALTER TABLE project_configs ALTER COLUMN override_sha256 SET NOT NULL`,

    `REVOKE ALL ON tenant_role_bindings FROM PUBLIC`,
    `GRANT SELECT, INSERT ON tenant_role_bindings TO platform_app`,
    `GRANT UPDATE (revoked_at) ON tenant_role_bindings TO platform_app`,
    `GRANT UPDATE (unlinked_at) ON user_identities TO platform_app`,
    `GRANT UPDATE (override_sha256) ON project_configs TO platform_app`,
  ],
  // Development only (ADR-M09).
  down: [
    `ALTER TABLE project_configs DROP COLUMN override_sha256`,
    `DROP TRIGGER user_identities_withdrawal_is_final ON user_identities`,
    `DROP INDEX user_identities_tenant_id_user_id_idx`,
    `DROP INDEX user_identities_linked_key`,
    `ALTER TABLE user_identities
       DROP CONSTRAINT user_identities_external_login_length,
       DROP CONSTRAINT user_identities_external_id_numeric,
       DROP CONSTRAINT user_identities_unlinked_after_creation,
       DROP COLUMN unlinked_at,
       ADD CONSTRAINT user_identities_tenant_id_provider_external_id_key
         UNIQUE (tenant_id, provider, external_id)`,
    `DROP TABLE tenant_role_bindings`,
    `DROP FUNCTION withdrawal_is_final()`,
    `DROP TYPE tenant_role`,
  ],
});
