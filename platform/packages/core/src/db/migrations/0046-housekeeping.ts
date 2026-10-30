// Migration 0046: housekeeping of web sessions and passkey challenges (task O04; design/ADR-M103;
// D-05 §6.1; QUESTIONS #647). Rules for every migration: see the header of 0001-tenancy.ts and
// design/ADR-M09. Migrations 0001–0045 are merged and never edited.
//
// - Two definer functions, owned by `platform`, remove one tenant's old rows: challenges used or
//   expired before a cutoff (never later than 1 hour ago), and sessions ended or expired before a
//   cutoff (never later than 7 days ago) that no challenge still needs. `platform_app` may run
//   them and still has no DELETE on either table.
// - The delete triggers refuse every DELETE (SDA01) unless it comes from inside a function, which
//   opens a transaction-local guard; even then only an old enough row goes (SDA27). TRUNCATE stays
//   refused. `platform_app` cannot open the guard to any use: it has no DELETE grant.
import { defineMigration } from './define.js';

const SESSION_FLOOR = `interval '7 days'`;
const CHALLENGE_FLOOR = `interval '1 hour'`;

export const migration0046Housekeeping = defineMigration({
  up: [
    // One trigger function per table: PL/pgSQL may read every column of a condition before it
    // decides, so a shared one would read a field the other table does not have.
    `CREATE FUNCTION web_sessions_delete_guard() RETURNS trigger
       LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
     BEGIN
       IF current_setting('sdlc.housekeeping', true) IS DISTINCT FROM 'on' THEN
         RAISE EXCEPTION 'append-only table: % not allowed on %', TG_OP, TG_TABLE_NAME
           USING ERRCODE = 'SDA01';
       END IF;
       IF LEAST(OLD.revoked_at, OLD.expires_at) > now() - ${SESSION_FLOOR} THEN
         RAISE EXCEPTION 'web session %: removed only 7 days after its end', OLD.id
           USING ERRCODE = 'SDA27';
       END IF;
       RETURN OLD;
     END $$`,
    `CREATE FUNCTION passkey_challenges_delete_guard() RETURNS trigger
       LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
     BEGIN
       IF current_setting('sdlc.housekeeping', true) IS DISTINCT FROM 'on' THEN
         RAISE EXCEPTION 'append-only table: % not allowed on %', TG_OP, TG_TABLE_NAME
           USING ERRCODE = 'SDA01';
       END IF;
       IF COALESCE(OLD.used_at, OLD.expires_at) > now() - ${CHALLENGE_FLOOR} THEN
         RAISE EXCEPTION 'passkey challenge %: removed only 1 hour after its end', OLD.id
           USING ERRCODE = 'SDA27';
       END IF;
       RETURN OLD;
     END $$`,
    `DROP TRIGGER web_sessions_no_delete ON web_sessions`,
    `CREATE TRIGGER web_sessions_no_delete BEFORE DELETE ON web_sessions
       FOR EACH ROW EXECUTE FUNCTION web_sessions_delete_guard()`,
    `DROP TRIGGER passkey_challenges_no_delete ON passkey_challenges`,
    `CREATE TRIGGER passkey_challenges_no_delete BEFORE DELETE ON passkey_challenges
       FOR EACH ROW EXECUTE FUNCTION passkey_challenges_delete_guard()`,

    `CREATE FUNCTION housekeeping_remove_passkey_challenges(p_tenant uuid, p_before timestamptz)
       RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
     DECLARE removed integer;
     BEGIN
       IF p_tenant IS NULL OR p_before IS NULL OR p_before > now() - ${CHALLENGE_FLOOR} THEN
         RAISE EXCEPTION 'challenges are removed only 1 hour after their end' USING ERRCODE = 'SDA27';
       END IF;
       PERFORM set_config('sdlc.housekeeping', 'on', true);
       DELETE FROM passkey_challenges
        WHERE tenant_id = p_tenant AND COALESCE(used_at, expires_at) < p_before;
       GET DIAGNOSTICS removed = ROW_COUNT;
       PERFORM set_config('sdlc.housekeeping', 'off', true);
       RETURN removed;
     END $$`,
    `CREATE FUNCTION housekeeping_remove_web_sessions(p_tenant uuid, p_before timestamptz)
       RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
     DECLARE removed integer;
     BEGIN
       IF p_tenant IS NULL OR p_before IS NULL OR p_before > now() - ${SESSION_FLOOR} THEN
         RAISE EXCEPTION 'web sessions are removed only 7 days after their end' USING ERRCODE = 'SDA27';
       END IF;
       PERFORM set_config('sdlc.housekeeping', 'on', true);
       DELETE FROM web_sessions s
        WHERE s.tenant_id = p_tenant
          AND LEAST(s.revoked_at, s.expires_at) < p_before
          AND NOT EXISTS (SELECT 1 FROM passkey_challenges c
                           WHERE c.tenant_id = s.tenant_id AND c.session_id = s.id);
       GET DIAGNOSTICS removed = ROW_COUNT;
       PERFORM set_config('sdlc.housekeeping', 'off', true);
       RETURN removed;
     END $$`,
    `REVOKE ALL ON FUNCTION housekeeping_remove_passkey_challenges(uuid, timestamptz) FROM PUBLIC`,
    `REVOKE ALL ON FUNCTION housekeeping_remove_web_sessions(uuid, timestamptz) FROM PUBLIC`,
    `GRANT EXECUTE ON FUNCTION housekeeping_remove_passkey_challenges(uuid, timestamptz) TO platform_app`,
    `GRANT EXECUTE ON FUNCTION housekeeping_remove_web_sessions(uuid, timestamptz) TO platform_app`,
  ],
  // Development only (ADR-M09).
  down: [
    `DROP FUNCTION housekeeping_remove_web_sessions(uuid, timestamptz)`,
    `DROP FUNCTION housekeeping_remove_passkey_challenges(uuid, timestamptz)`,
    `DROP TRIGGER passkey_challenges_no_delete ON passkey_challenges`,
    `CREATE TRIGGER passkey_challenges_no_delete BEFORE DELETE ON passkey_challenges
       FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`,
    `DROP TRIGGER web_sessions_no_delete ON web_sessions`,
    `CREATE TRIGGER web_sessions_no_delete BEFORE DELETE ON web_sessions
       FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`,
    `DROP FUNCTION passkey_challenges_delete_guard()`,
    `DROP FUNCTION web_sessions_delete_guard()`,
  ],
});
