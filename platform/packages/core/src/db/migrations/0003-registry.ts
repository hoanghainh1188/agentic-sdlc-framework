// Migration 0003: registry of intents, spec references, plans and gate decisions (design/D-05
// sections 5, 6.2, 6.3 and 9; D-08 B02; design/ADR-M20).
// Rules for every migration: see the header of 0001-tenancy.ts and design/ADR-M09.
//
// `gate_decisions` is append-only (D-05 D3): the `forbid_mutation()` triggers of migration 0002
// and SELECT, INSERT grants only. It is kept at least 2 years, so it holds codes, hashes and IDs,
// never free text: `reason_code` plus an optional link to the explanation on the Git host.
//
// Errors raised by the triggers (class `SD`, mapped in errors.ts):
//   SDA04  a `void` decision must point to an `approve` decision
import { defineMigration } from './define.js';

const HEX64 = `~ '^[0-9a-f]{64}$'`;
const HEX40 = `~ '^[0-9a-f]{40}$'`;

export const migration0003Registry = defineMigration({
  up: [
    `CREATE TYPE gate_code AS ENUM ('G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8')`,
    `CREATE TYPE risk_tier AS ENUM ('low', 'medium', 'high', 'critical')`,
    `CREATE TYPE autonomy_level AS ENUM ('L0', 'L1', 'L2', 'L3', 'L4')`,
    `CREATE TYPE change_flag AS ENUM
       ('migration', 'breaking_contract', 'new_service_boundary', 'security_boundary',
        'system_of_record', 'prod_infrastructure', 'core_business_rule', 'payment',
        'personal_data', 'safety_function')`,
    `CREATE TYPE intent_status AS ENUM
       ('draft', 'in_gate', 'running', 'paused', 'blocked', 'done', 'rejected', 'cancelled')`,
    `CREATE TYPE gate_decision AS ENUM
       ('approve', 'reject', 'request_changes', 'pause', 'block', 'pass', 'fail', 'void')`,
    // Oversight modes plus POLICY, the automatic check at G4 (QUESTIONS #6, ADR-M20).
    `CREATE TYPE gate_check_mode AS ENUM ('HITL', 'HOTL', 'AUDIT', 'POLICY')`,
    `CREATE TYPE gate_reason_code AS ENUM
       ('spec_unclear', 'tests_insufficient', 'security_finding', 'out_of_scope', 'policy_denied',
        'budget_exceeded', 'ci_failed', 'ai_record_missing', 'data_class_not_allowed', 'expired',
        'input_mismatch', 'scope_mismatch', 'other')`,
    `CREATE TYPE event_source AS ENUM ('polling', 'webhook')`,

    `CREATE TABLE intents (
       id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id    uuid NOT NULL,
       code         text NOT NULL CHECK (code ~ '^INT-[0-9]{4}-[0-9]{4,9}$'),
       project_id   uuid NOT NULL,
       title        text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
       description  text NOT NULL DEFAULT '' CHECK (length(description) <= 20000),
       created_by   uuid NOT NULL,
       risk_tier    risk_tier NOT NULL,
       data_class   data_class NOT NULL,
       max_autonomy autonomy_level NOT NULL,
       budget_usd   numeric(18,6) NOT NULL CHECK (budget_usd >= 0),
       current_gate gate_code,
       status       intent_status NOT NULL DEFAULT 'draft',
       issue_number integer CHECK (issue_number >= 1),
       pr_number    integer CHECK (pr_number >= 1),
       updated_at   timestamptz NOT NULL DEFAULT now(),
       created_at   timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT intents_tenant_id_id_key UNIQUE (tenant_id, id),
       CONSTRAINT intents_tenant_id_code_key UNIQUE (tenant_id, code),
       CONSTRAINT intents_project_fkey FOREIGN KEY (tenant_id, project_id)
         REFERENCES projects (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT intents_created_by_fkey FOREIGN KEY (tenant_id, created_by)
         REFERENCES users (tenant_id, id) ON DELETE RESTRICT
     )`,
    `CREATE INDEX intents_tenant_id_project_id_status_idx ON intents (tenant_id, project_id, status)`,

    `CREATE TABLE spec_refs (
       id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id      uuid NOT NULL,
       intent_id      uuid NOT NULL,
       version        integer NOT NULL CHECK (version >= 1),
       path           text NOT NULL CHECK (
                        length(path) BETWEEN 1 AND 1024
                        AND path !~ '^/' AND path !~ '\\\\' AND path !~ '(^|/)\\.\\.?(/|$)'),
       commit_sha     char(40) NOT NULL CHECK (commit_sha ${HEX40}),
       content_sha256 char(64) NOT NULL CHECK (content_sha256 ${HEX64}),
       source_tool    text CHECK (source_tool IN ('spec-kit', 'bmad', 'manual')),
       created_at     timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT spec_refs_tenant_id_id_key UNIQUE (tenant_id, id),
       CONSTRAINT spec_refs_tenant_id_intent_id_version_key UNIQUE (tenant_id, intent_id, version),
       CONSTRAINT spec_refs_intent_fkey FOREIGN KEY (tenant_id, intent_id)
         REFERENCES intents (tenant_id, id) ON DELETE RESTRICT
     )`,

    `CREATE TABLE plans (
       id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id        uuid NOT NULL,
       intent_id        uuid NOT NULL,
       version          integer NOT NULL CHECK (version >= 1),
       planned_files    text[] NOT NULL CHECK (cardinality(planned_files) BETWEEN 1 AND 1000),
       summary          text NOT NULL DEFAULT '' CHECK (length(summary) <= 20000),
       plan_sha256      char(64) NOT NULL CHECK (plan_sha256 ${HEX64}),
       proposed_by_type actor_type NOT NULL,
       change_flags     change_flag[] NOT NULL DEFAULT '{}',
       created_at       timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT plans_tenant_id_id_key UNIQUE (tenant_id, id),
       CONSTRAINT plans_tenant_id_intent_id_version_key UNIQUE (tenant_id, intent_id, version),
       CONSTRAINT plans_intent_fkey FOREIGN KEY (tenant_id, intent_id)
         REFERENCES intents (tenant_id, id) ON DELETE RESTRICT
     )`,

    `CREATE TABLE gate_decisions (
       id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id         uuid NOT NULL,
       intent_id         uuid NOT NULL,
       gate              gate_code NOT NULL,
       decision          gate_decision NOT NULL,
       oversight_mode    gate_check_mode NOT NULL,
       approver_role     project_role,
       actor_type        actor_type NOT NULL,
       decided_by        uuid,
       reason_code       gate_reason_code,
       -- A link to the explanation on the Git host; the text itself is never stored here.
       -- (PostgreSQL regexes allow at most 255 repetitions, so the length is checked apart.)
       reason_ref        text CHECK (reason_ref ~ '^https://[^[:space:]]+$' AND length(reason_ref) <= 512),
       input_sha256      char(64) NOT NULL CHECK (input_sha256 ${HEX64}),
       scope             jsonb CHECK (jsonb_typeof(scope) = 'object'),
       expires_at        timestamptz,
       config_hash       char(64) NOT NULL CHECK (config_hash ${HEX64}),
       source            text NOT NULL
                           CHECK (source IN ('cli', 'github_comment', 'github_review', 'workflow')),
       event_source      event_source,
       waited_seconds    integer CHECK (waited_seconds >= 0),
       voids_decision_id uuid,
       created_at        timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT gate_decisions_tenant_id_id_key UNIQUE (tenant_id, id),
       -- Target of the void link below: a void cancels an approval of the same intent and gate.
       CONSTRAINT gate_decisions_tenant_id_intent_id_gate_id_key UNIQUE (tenant_id, intent_id, gate, id),
       CONSTRAINT gate_decisions_intent_fkey FOREIGN KEY (tenant_id, intent_id)
         REFERENCES intents (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT gate_decisions_decided_by_fkey FOREIGN KEY (tenant_id, decided_by)
         REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT gate_decisions_voids_fkey FOREIGN KEY (tenant_id, intent_id, gate, voids_decision_id)
         REFERENCES gate_decisions (tenant_id, intent_id, gate, id) ON DELETE RESTRICT,
       -- D-02 FR-11: agents never decide or approve.
       CONSTRAINT gate_decisions_no_agent CHECK (actor_type <> 'agent'),
       CONSTRAINT gate_decisions_decided_by CHECK ((actor_type = 'human') = (decided_by IS NOT NULL)),
       CONSTRAINT gate_decisions_human_decisions CHECK (
         actor_type <> 'human' OR decision IN ('approve', 'reject', 'request_changes', 'pause', 'block')),
       CONSTRAINT gate_decisions_system_decisions CHECK (
         actor_type <> 'system' OR decision IN ('pass', 'fail', 'block', 'pause', 'void')),
       CONSTRAINT gate_decisions_role_human_only CHECK (actor_type = 'human' OR approver_role IS NULL),
       -- An approval is bound to a role, an expiry and a human oversight mode (D-03 section 6.3).
       CONSTRAINT gate_decisions_approval_binding CHECK (
         decision <> 'approve'
         OR (approver_role IS NOT NULL AND expires_at IS NOT NULL AND oversight_mode IN ('HITL', 'HOTL'))),
       CONSTRAINT gate_decisions_expiry_approve_only CHECK (decision = 'approve' OR expires_at IS NULL),
       -- QUESTIONS #6: POLICY is the automatic check at G4, decided by the system.
       CONSTRAINT gate_decisions_policy_g4 CHECK (
         oversight_mode <> 'POLICY' OR (gate = 'G4' AND actor_type = 'system')),
       CONSTRAINT gate_decisions_reason_required CHECK (
         decision NOT IN ('reject', 'request_changes', 'block', 'fail', 'void') OR reason_code IS NOT NULL),
       CONSTRAINT gate_decisions_void_link CHECK ((decision = 'void') = (voids_decision_id IS NOT NULL)),
       CONSTRAINT gate_decisions_event_source CHECK (
         event_source IS NULL OR source IN ('github_comment', 'github_review'))
     )`,
    `CREATE INDEX gate_decisions_tenant_id_intent_id_created_at_idx
       ON gate_decisions (tenant_id, intent_id, created_at)`,
    // An approval is voided at most once.
    `CREATE UNIQUE INDEX gate_decisions_voids_decision_key
       ON gate_decisions (tenant_id, voids_decision_id) WHERE voids_decision_id IS NOT NULL`,

    `CREATE TRIGGER gate_decisions_no_update_delete BEFORE UPDATE OR DELETE ON gate_decisions
       FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`,
    `CREATE TRIGGER gate_decisions_no_truncate BEFORE TRUNCATE ON gate_decisions
       FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()`,

    // The foreign key proves the voided row exists for the same intent and gate; this trigger
    // proves it is an approval.
    `CREATE FUNCTION gate_decisions_check_void() RETURNS trigger
       LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
     BEGIN
       IF NEW.voids_decision_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM gate_decisions
         WHERE tenant_id = NEW.tenant_id AND id = NEW.voids_decision_id AND decision = 'approve'
       ) THEN
         RAISE EXCEPTION 'gate decision %: only an approval can be voided', NEW.voids_decision_id
           USING ERRCODE = 'SDA04';
       END IF;
       RETURN NEW;
     END $$`,
    `CREATE TRIGGER gate_decisions_check_void BEFORE INSERT ON gate_decisions
       FOR EACH ROW EXECUTE FUNCTION gate_decisions_check_void()`,

    `REVOKE ALL ON intents, spec_refs, plans, gate_decisions FROM PUBLIC`,
    `GRANT SELECT, INSERT ON intents, spec_refs, plans, gate_decisions TO platform_app`,
    // Current state only; history lives in gate_decisions and audit_log (D-05 section 6.2).
    `GRANT UPDATE (current_gate, status, issue_number, pr_number, updated_at) ON intents TO platform_app`,
  ],
  down: [
    `DROP TABLE gate_decisions`,
    `DROP FUNCTION gate_decisions_check_void()`,
    `DROP TABLE plans`,
    `DROP TABLE spec_refs`,
    `DROP TABLE intents`,
    `DROP TYPE event_source`,
    `DROP TYPE gate_reason_code`,
    `DROP TYPE gate_check_mode`,
    `DROP TYPE gate_decision`,
    `DROP TYPE intent_status`,
    `DROP TYPE change_flag`,
    `DROP TYPE autonomy_level`,
    `DROP TYPE risk_tier`,
    `DROP TYPE gate_code`,
  ],
});
