// Migration 0008: the agent register (design/D-05 sections 5 and 6.1, D-08 C10, design/ADR-M31).
// Rules for every migration: see the header of 0001-tenancy.ts and design/ADR-M09.
//
// - `agents` holds one row per registered agent of a tenant. Rows are never deleted: a retired agent
//   stays as a tombstone, so its `agent_key` is never reused (handbook Ch.20 §20.10 step 8).
// - Every column is coded (keys, versions, gateway model names, tool codes, hashes): no free text,
//   no personal data (CLAUDE.md "Current constraints").
// - A trigger allows only the status moves of handbook Ch.20 (ADR-M31 §2.3) and refuses any change
//   once `retired`. The configuration (model, instructions, tools, autonomy, environments) changes
//   only while `proposed` or `suspended`, and only together with a new `version`: a change is a new
//   version (Ch.20 §20.9).
// - `runs.agent_id` gets its foreign key to the register (QUESTIONS.md #32).
//
// Custom SQLSTATE (translated in errors.ts):
//   SDA09  an agent status move that is not allowed, a change to a retired agent, or a
//          configuration change without a new version or outside `proposed` / `suspended`
import { defineMigration } from './define.js';

// Same formats as the Run Contract (`@sdlc/contracts` run-contract.ts): the register feeds it.
const VERSION_LABEL = `~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$'`;
const MODEL = `~ '^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$'`;
const TOOL = `'^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$'`;
// A relative path in the repository, then `@` and a version label: `AGENTS.md@v5`.
const INSTRUCTIONS_REF = `~ '^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}@[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$'`;
const CONFIG_COLUMNS = [
  'model_ref',
  'instructions_ref',
  'instructions_sha256',
  'allowed_tools',
  'max_autonomy',
  'approved_environments',
];

export const migration0008Agents = defineMigration({
  up: [
    `CREATE TYPE agent_status AS ENUM ('proposed', 'active', 'suspended', 'quarantined', 'retired')`,

    `CREATE FUNCTION agent_tools_are_codes(tools text[]) RETURNS boolean
       LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
       SELECT cardinality(tools) <= 100
         AND array_position(tools, NULL) IS NULL
         AND NOT EXISTS (SELECT 1 FROM unnest(tools) AS t(tool) WHERE t.tool !~ ${TOOL})
         AND cardinality(tools) = (SELECT count(DISTINCT t.tool) FROM unnest(tools) AS t(tool))
     $$`,

    `CREATE TABLE agents (
       id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id             uuid NOT NULL,
       agent_key             text NOT NULL CHECK (agent_key ~ '^[a-z][a-z0-9-]{0,62}[a-z0-9]$'),
       version               text NOT NULL CHECK (version ${VERSION_LABEL}),
       status                agent_status NOT NULL DEFAULT 'proposed',
       owner_id              uuid NOT NULL,
       -- The LiteLLM gateway model name, which includes the model version (ADR-M31 §2.4): at
       -- least one digit, never a moving alias such as 'latest'. Null until pinned; an active
       -- agent always has one.
       model_ref             text CHECK (
                               model_ref ${MODEL} AND model_ref ~ '[0-9]'
                               AND model_ref !~* 'latest'),
       instructions_ref      text NOT NULL CHECK (
                               instructions_ref ${INSTRUCTIONS_REF}
                               AND instructions_ref !~ '(^|/)\\.{1,2}(/|@)'
                               AND instructions_ref !~ '//'),
       instructions_sha256   char(64) NOT NULL CHECK (instructions_sha256 ~ '^[0-9a-f]{64}$'),
       allowed_tools         text[] NOT NULL DEFAULT '{}' CHECK (agent_tools_are_codes(allowed_tools)),
       max_autonomy          autonomy_level NOT NULL,
       approved_environments text[] NOT NULL DEFAULT '{}' CHECK (
                               approved_environments <@ ARRAY['sandbox', 'staging', 'production']
                               AND array_position(approved_environments, NULL) IS NULL),
       last_recertified_at   date,
       updated_at            timestamptz NOT NULL DEFAULT now(),
       created_at            timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT agents_tenant_id_id_key UNIQUE (tenant_id, id),
       -- Retired agents keep their key: an identity is never reused (Ch.20 §20.10 step 8).
       CONSTRAINT agents_tenant_id_agent_key_key UNIQUE (tenant_id, agent_key),
       CONSTRAINT agents_owner_fkey FOREIGN KEY (tenant_id, owner_id)
         REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
       -- Only an agent with a pinned model and a certification date may run (D-02 FR-36).
       CONSTRAINT agents_active_is_pinned CHECK (
         status <> 'active' OR (model_ref IS NOT NULL AND last_recertified_at IS NOT NULL))
     )`,

    `CREATE FUNCTION agents_changes() RETURNS trigger
       LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
     BEGIN
       IF OLD.status = 'retired' THEN
         RAISE EXCEPTION 'agent %: retired', OLD.id USING ERRCODE = 'SDA09';
       END IF;
       IF NEW.status <> OLD.status AND NOT (
            (OLD.status = 'proposed'    AND NEW.status IN ('active', 'retired'))
         OR (OLD.status = 'active'      AND NEW.status IN ('suspended', 'quarantined', 'retired'))
         OR (OLD.status = 'suspended'   AND NEW.status IN ('active', 'quarantined', 'retired'))
         OR (OLD.status = 'quarantined' AND NEW.status IN ('suspended', 'retired'))) THEN
         RAISE EXCEPTION 'agent %: status % cannot become %', OLD.id, OLD.status, NEW.status
           USING ERRCODE = 'SDA09';
       END IF;
       IF NEW.version IS DISTINCT FROM OLD.version
          OR ${CONFIG_COLUMNS.map((c) => `NEW.${c} IS DISTINCT FROM OLD.${c}`).join('\n          OR ')}
       THEN
         IF OLD.status NOT IN ('proposed', 'suspended') OR NEW.status <> OLD.status
            OR NEW.version = OLD.version THEN
           RAISE EXCEPTION 'agent %: configuration changes need a new version while proposed or suspended',
             OLD.id USING ERRCODE = 'SDA09';
         END IF;
       END IF;
       IF NEW.last_recertified_at IS DISTINCT FROM OLD.last_recertified_at
          AND (NEW.last_recertified_at IS NULL OR NEW.last_recertified_at < OLD.last_recertified_at) THEN
         RAISE EXCEPTION 'agent %: the recertification date never goes back', OLD.id
           USING ERRCODE = 'SDA09';
       END IF;
       RETURN NEW;
     END $$`,
    `CREATE TRIGGER agents_changes BEFORE UPDATE ON agents
       FOR EACH ROW EXECUTE FUNCTION agents_changes()`,

    `REVOKE ALL ON agents FROM PUBLIC`,
    `GRANT SELECT, INSERT ON agents TO platform_app`,
    // State, owner and configuration; the identity (`agent_key`, `tenant_id`) never changes.
    `GRANT UPDATE (version, status, owner_id, model_ref, instructions_ref, instructions_sha256,
       allowed_tools, max_autonomy, approved_environments, last_recertified_at, updated_at)
       ON agents TO platform_app`,

    // QUESTIONS.md #32: runs refer to a registered agent of the same tenant.
    `ALTER TABLE runs ADD CONSTRAINT runs_agent_fkey FOREIGN KEY (tenant_id, agent_id)
       REFERENCES agents (tenant_id, id) ON DELETE RESTRICT`,
  ],
  down: [
    `ALTER TABLE runs DROP CONSTRAINT runs_agent_fkey`,
    `DROP TABLE agents`,
    `DROP FUNCTION agents_changes()`,
    `DROP FUNCTION agent_tools_are_codes(text[])`,
    `DROP TYPE agent_status`,
  ],
});
