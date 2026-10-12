// Migration 0028: writes from the dashboard (design/D-05 section 6.1, version 1.42; D-08 U06;
// design/ADR-M73 §2.3, §2.4; QUESTIONS #410–#414). Rules for every migration: see the header of
// 0001-tenancy.ts and design/ADR-M09.
//
// - `web_sessions.csrf_sha256`: the SHA-256 of the session's CSRF token (QUESTIONS #410). The token
//   is derived from the session secret (HMAC), so the api can give it back to the page without
//   storing it; written at sign-in, never changed (trigger SDA18, replaced here). Sessions made
//   before this migration have none and can only read.
// - `webauthn_credentials`: a person's passkeys. The public key and the counter, never a private
//   key, never free text. The counter only grows; the end is set once (trigger SDA20).
// - `passkey_challenges`: one random challenge (only its hash is stored) for a passkey
//   registration or for one step-up, bound to the session and the action (QUESTIONS #411). Only
//   `used_at` changes, once, before the expiry (trigger SDA19).
// - No DELETE on either table for `platform_app` (QUESTIONS #412): rows stay; removing old
//   challenges is a later retention-loop task with its own grant.
// - Codes, IDs, hashes, keys and times only.
import { defineMigration } from './define.js';

const HEX64 = `~ '^[0-9a-f]{64}$'`;
const CODE = `~ '^[a-z][a-z0-9_.]{0,63}$'`;

export const migration0028DashboardWrites = defineMigration({
  up: [
    `ALTER TABLE web_sessions
       ADD COLUMN csrf_sha256 char(64) CHECK (csrf_sha256 ${HEX64})`,
    // Challenges refer to the session with the tenant (D-05 D2): the parent needs the key.
    `ALTER TABLE web_sessions
       ADD CONSTRAINT web_sessions_tenant_id_id_key UNIQUE (tenant_id, id)`,
    `CREATE OR REPLACE FUNCTION web_sessions_fixed() RETURNS trigger
       LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
     BEGIN
       IF (NEW.id, NEW.tenant_id, NEW.user_id, NEW.identity_id, NEW.secret_sha256, NEW.csrf_sha256,
           NEW.expires_at, NEW.created_at)
          IS DISTINCT FROM
          (OLD.id, OLD.tenant_id, OLD.user_id, OLD.identity_id, OLD.secret_sha256, OLD.csrf_sha256,
           OLD.expires_at, OLD.created_at) THEN
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

    `CREATE TABLE webauthn_credentials (
       id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id      uuid NOT NULL,
       user_id        uuid NOT NULL,
       -- PostgreSQL regular expressions allow at most 255 repetitions: the length apart.
       credential_id  text NOT NULL CHECK (credential_id ~ '^[A-Za-z0-9_-]+$'
                        AND char_length(credential_id) BETWEEN 16 AND 1366),
       public_key     bytea NOT NULL
                        CHECK (octet_length(public_key) BETWEEN 16 AND 2048),
       algorithm      smallint NOT NULL CHECK (algorithm IN (-7, -8, -257)),
       sign_count     bigint NOT NULL DEFAULT 0 CHECK (sign_count BETWEEN 0 AND 4294967295),
       aaguid         uuid,
       last_used_at   timestamptz,
       revoked_at     timestamptz,
       revoked_by     uuid,
       created_at     timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT webauthn_credentials_tenant_id_id_key UNIQUE (tenant_id, id),
       -- Unique across tenants: a passkey belongs to one person on one site.
       CONSTRAINT webauthn_credentials_credential_id_key UNIQUE (credential_id),
       CONSTRAINT webauthn_credentials_user_fkey FOREIGN KEY (tenant_id, user_id)
         REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT webauthn_credentials_revoked_by_fkey FOREIGN KEY (tenant_id, revoked_by)
         REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT webauthn_credentials_end CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
     )`,
    `CREATE INDEX webauthn_credentials_active ON webauthn_credentials (tenant_id, user_id)
       WHERE revoked_at IS NULL`,
    `CREATE FUNCTION webauthn_credentials_fixed() RETURNS trigger
       LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
     BEGIN
       IF (NEW.id, NEW.tenant_id, NEW.user_id, NEW.credential_id, NEW.public_key, NEW.algorithm,
           NEW.aaguid, NEW.created_at)
          IS DISTINCT FROM
          (OLD.id, OLD.tenant_id, OLD.user_id, OLD.credential_id, OLD.public_key, OLD.algorithm,
           OLD.aaguid, OLD.created_at) THEN
         RAISE EXCEPTION 'passkey %: only the counter, the last use and the end change', OLD.id
           USING ERRCODE = 'SDA20';
       END IF;
       IF OLD.revoked_at IS NOT NULL THEN
         RAISE EXCEPTION 'passkey %: revoked once, then fixed', OLD.id USING ERRCODE = 'SDA20';
       END IF;
       IF NEW.sign_count < OLD.sign_count THEN
         RAISE EXCEPTION 'passkey %: the counter only grows', OLD.id USING ERRCODE = 'SDA20';
       END IF;
       IF OLD.last_used_at IS NOT NULL
          AND (NEW.last_used_at IS NULL OR NEW.last_used_at < OLD.last_used_at) THEN
         RAISE EXCEPTION 'passkey %: last_used_at only grows', OLD.id USING ERRCODE = 'SDA20';
       END IF;
       RETURN NEW;
     END $$`,
    `CREATE TRIGGER webauthn_credentials_fixed BEFORE UPDATE ON webauthn_credentials
       FOR EACH ROW EXECUTE FUNCTION webauthn_credentials_fixed()`,
    `CREATE TRIGGER webauthn_credentials_no_delete BEFORE DELETE ON webauthn_credentials
       FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`,
    `CREATE TRIGGER webauthn_credentials_no_truncate BEFORE TRUNCATE ON webauthn_credentials
       FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()`,
    `REVOKE ALL ON webauthn_credentials FROM PUBLIC`,
    `GRANT SELECT, INSERT ON webauthn_credentials TO platform_app`,
    `GRANT UPDATE (sign_count, last_used_at, revoked_at, revoked_by)
       ON webauthn_credentials TO platform_app`,

    `CREATE TABLE passkey_challenges (
       id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id              uuid NOT NULL,
       user_id                uuid NOT NULL,
       session_id             uuid NOT NULL,
       purpose                text NOT NULL CHECK (purpose IN ('register', 'step_up')),
       action                 text CHECK (action ${CODE}),
       intent_id              uuid,
       escalation_id          uuid,
       gate                   gate_code,
       decision               text CHECK (decision ${CODE}),
       expected_input_sha256  char(64) CHECK (expected_input_sha256 ${HEX64}),
       request_sha256         char(64) CHECK (request_sha256 ${HEX64}),
       challenge_sha256       char(64) NOT NULL CHECK (challenge_sha256 ${HEX64}),
       expires_at             timestamptz NOT NULL,
       used_at                timestamptz,
       created_at             timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT passkey_challenges_challenge_key UNIQUE (challenge_sha256),
       CONSTRAINT passkey_challenges_user_fkey FOREIGN KEY (tenant_id, user_id)
         REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT passkey_challenges_session_fkey FOREIGN KEY (tenant_id, session_id)
         REFERENCES web_sessions (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT passkey_challenges_intent_fkey FOREIGN KEY (tenant_id, intent_id)
         REFERENCES intents (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT passkey_challenges_escalation_fkey FOREIGN KEY (tenant_id, escalation_id)
         REFERENCES escalations (tenant_id, id) ON DELETE RESTRICT,
       -- A registration binds nothing but the session; a step-up names its action and request.
       CONSTRAINT passkey_challenges_binding CHECK (
         (purpose = 'register' AND action IS NULL AND intent_id IS NULL AND escalation_id IS NULL
            AND gate IS NULL AND decision IS NULL AND expected_input_sha256 IS NULL
            AND request_sha256 IS NULL)
         OR (purpose = 'step_up' AND action IS NOT NULL AND request_sha256 IS NOT NULL)),
       CONSTRAINT passkey_challenges_lifetime CHECK (
         expires_at > created_at AND expires_at <= created_at + interval '10 minutes')
     )`,
    `CREATE INDEX passkey_challenges_open ON passkey_challenges (tenant_id, session_id)
       WHERE used_at IS NULL`,
    `CREATE FUNCTION passkey_challenges_fixed() RETURNS trigger
       LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
     BEGIN
       IF (NEW.id, NEW.tenant_id, NEW.user_id, NEW.session_id, NEW.purpose, NEW.action,
           NEW.intent_id, NEW.escalation_id, NEW.gate, NEW.decision, NEW.expected_input_sha256,
           NEW.request_sha256, NEW.challenge_sha256, NEW.expires_at, NEW.created_at)
          IS DISTINCT FROM
          (OLD.id, OLD.tenant_id, OLD.user_id, OLD.session_id, OLD.purpose, OLD.action,
           OLD.intent_id, OLD.escalation_id, OLD.gate, OLD.decision, OLD.expected_input_sha256,
           OLD.request_sha256, OLD.challenge_sha256, OLD.expires_at, OLD.created_at) THEN
         RAISE EXCEPTION 'passkey challenge %: only used_at changes', OLD.id
           USING ERRCODE = 'SDA19';
       END IF;
       IF OLD.used_at IS NOT NULL THEN
         RAISE EXCEPTION 'passkey challenge %: used once', OLD.id USING ERRCODE = 'SDA19';
       END IF;
       IF NEW.used_at IS NULL OR NEW.used_at > OLD.expires_at THEN
         RAISE EXCEPTION 'passkey challenge %: used before it expires', OLD.id
           USING ERRCODE = 'SDA19';
       END IF;
       RETURN NEW;
     END $$`,
    `CREATE TRIGGER passkey_challenges_fixed BEFORE UPDATE ON passkey_challenges
       FOR EACH ROW EXECUTE FUNCTION passkey_challenges_fixed()`,
    `CREATE TRIGGER passkey_challenges_no_delete BEFORE DELETE ON passkey_challenges
       FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`,
    `CREATE TRIGGER passkey_challenges_no_truncate BEFORE TRUNCATE ON passkey_challenges
       FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()`,
    `REVOKE ALL ON passkey_challenges FROM PUBLIC`,
    `GRANT SELECT, INSERT ON passkey_challenges TO platform_app`,
    `GRANT UPDATE (used_at) ON passkey_challenges TO platform_app`,
  ],
  // Development only (ADR-M09).
  down: [
    `DROP TABLE passkey_challenges`,
    `DROP FUNCTION passkey_challenges_fixed()`,
    `DROP TABLE webauthn_credentials`,
    `DROP FUNCTION webauthn_credentials_fixed()`,
    `ALTER TABLE web_sessions DROP CONSTRAINT web_sessions_tenant_id_id_key`,
    `CREATE OR REPLACE FUNCTION web_sessions_fixed() RETURNS trigger
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
    `ALTER TABLE web_sessions DROP COLUMN csrf_sha256`,
  ],
});
