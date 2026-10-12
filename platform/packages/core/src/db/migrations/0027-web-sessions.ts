// Migration 0027: dashboard sign-in sessions (design/D-05 section 6.1, version 1.41; D-08 U05;
// design/ADR-M73 §2.2; QUESTIONS #385–#389). Rules for every migration: see the header of
// 0001-tenancy.ts and design/ADR-M09.
//
// - One row per sign-in with GitHub. The browser holds the session secret in the cookie
//   `__Host-sdlc_session`; this table holds only its SHA-256 (`secret_sha256`), never the secret.
//   The CSRF token comes with U06, in its own migration (QUESTIONS #386).
// - `identity_id` is the linked GitHub identity the person signed in with: unlinking it ends the
//   session (ADR-M73 §2.2).
// - Not an append-only table, but close: only `last_seen_at` (only grows) and the end of the
//   session (`revoked_at` with `end_reason`, set once, together) change (trigger `SDA18`).
// - No DELETE for `platform_app` (Harry, 2026-10-10): expired rows stay (hashes and times only);
//   removing them is a later retention-loop task with its own grant.
// - Codes, IDs, hashes and times only.
import { defineMigration } from './define.js';

const HEX64 = `~ '^[0-9a-f]{64}$'`;

export const migration0027WebSessions = defineMigration({
  up: [
    // The session refers to the identity with the tenant (D-05 D2): the parent needs the key.
    `ALTER TABLE user_identities
       ADD CONSTRAINT user_identities_tenant_id_id_key UNIQUE (tenant_id, id)`,
    `CREATE TABLE web_sessions (
       id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id      uuid NOT NULL,
       user_id        uuid NOT NULL,
       identity_id    uuid NOT NULL,
       secret_sha256  char(64) NOT NULL CHECK (secret_sha256 ${HEX64}),
       last_seen_at   timestamptz NOT NULL,
       expires_at     timestamptz NOT NULL,
       revoked_at     timestamptz,
       end_reason     text CHECK (end_reason IN
                        ('sign_out', 'all', 'admin', 'user_disabled', 'identity_unlinked',
                         'replaced')),
       created_at     timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT web_sessions_user_fkey FOREIGN KEY (tenant_id, user_id)
         REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT web_sessions_identity_fkey FOREIGN KEY (tenant_id, identity_id)
         REFERENCES user_identities (tenant_id, id) ON DELETE RESTRICT,
       -- Unique across tenants: the tenant is found from the cookie (as for API tokens).
       CONSTRAINT web_sessions_secret_sha256_key UNIQUE (secret_sha256),
       CONSTRAINT web_sessions_expires_after_creation CHECK (expires_at > created_at),
       CONSTRAINT web_sessions_seen CHECK (last_seen_at >= created_at - interval '1 minute'),
       CONSTRAINT web_sessions_end CHECK ((revoked_at IS NULL) = (end_reason IS NULL))
     )`,
    `CREATE INDEX web_sessions_open ON web_sessions (tenant_id, user_id) WHERE revoked_at IS NULL`,
    `CREATE INDEX web_sessions_identity_open ON web_sessions (tenant_id, identity_id)
       WHERE revoked_at IS NULL`,
    `CREATE FUNCTION web_sessions_fixed() RETURNS trigger
       LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
     BEGIN
       IF (NEW.id, NEW.tenant_id, NEW.user_id, NEW.identity_id, NEW.secret_sha256, NEW.expires_at,
           NEW.created_at)
          IS DISTINCT FROM
          (OLD.id, OLD.tenant_id, OLD.user_id, OLD.identity_id, OLD.secret_sha256, OLD.expires_at,
           OLD.created_at) THEN
         RAISE EXCEPTION 'web session %: only last_seen_at and the end change', OLD.id
           USING ERRCODE = 'SDA18';
       END IF;
       IF NEW.last_seen_at < OLD.last_seen_at THEN
         RAISE EXCEPTION 'web session %: last_seen_at only grows', OLD.id USING ERRCODE = 'SDA18';
       END IF;
       IF OLD.revoked_at IS NOT NULL
          AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
               OR NEW.end_reason IS DISTINCT FROM OLD.end_reason
               OR NEW.last_seen_at IS DISTINCT FROM OLD.last_seen_at) THEN
         RAISE EXCEPTION 'web session %: ended once, then fixed', OLD.id USING ERRCODE = 'SDA18';
       END IF;
       RETURN NEW;
     END $$`,
    `CREATE TRIGGER web_sessions_fixed BEFORE UPDATE ON web_sessions
       FOR EACH ROW EXECUTE FUNCTION web_sessions_fixed()`,
    `CREATE TRIGGER web_sessions_no_delete BEFORE DELETE ON web_sessions
       FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`,
    `CREATE TRIGGER web_sessions_no_truncate BEFORE TRUNCATE ON web_sessions
       FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()`,
    `REVOKE ALL ON web_sessions FROM PUBLIC`,
    `GRANT SELECT, INSERT ON web_sessions TO platform_app`,
    `GRANT UPDATE (last_seen_at, revoked_at, end_reason) ON web_sessions TO platform_app`,
  ],
  // Development only (ADR-M09).
  down: [
    `DROP TABLE web_sessions`,
    `DROP FUNCTION web_sessions_fixed()`,
    `ALTER TABLE user_identities DROP CONSTRAINT user_identities_tenant_id_id_key`,
  ],
});
