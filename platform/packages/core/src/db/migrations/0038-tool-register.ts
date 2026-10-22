// Migration 0038: the tool register (design/D-05 sections 5 and 6.1, versions 1.54 and 1.56; D-08
// X04; design/ADR-M69 §2.2–§2.3). Rules for every migration: see the header of 0001-tenancy.ts and
// design/ADR-M09. Migrations 0001–0037 are merged and never edited.
//
// - `tools` holds one row per register tool of a tenant (`tool:<tool_key>` in the tool lists). Rows
//   are never deleted: a retired tool stays as a tombstone, so its key is never reused.
// - Every column is coded (keys, versions, image names and digests, permission codes, data
//   classes, `alias:port`, gateway model names): no free text, no personal data.
// - A trigger allows only the status moves of `agent_status` (ADR-M31 §2.3) and refuses any change
//   once `retired`. The configuration changes only while `proposed` or `suspended`, and only
//   together with a new `version`: a new image digest is a new version.
// - An `http` tool has an image; an `active` one has its digest and a certification date. A `stdio`
//   tool has no image and no backing service (ADR-M69 §2.5). `prohibited` data is never allowed.
// - `tool_approvals` (append-only): one row per person who approved a tool's activation or
//   retirement, bound to the tool as it was (its version and `updated_at`), like `agent_approvals`.
// - `gate_reason_code` gets `tool_not_runnable` (G4, ADR-M69 §2.3).
// - `plans.allowed_tools` may hold register tools (`tool:<key>`, ADR-M69 §2.1) next to the three
//   built-in tools: at most 10 of them, no duplicate.
//
// Custom SQLSTATE (translated in errors.ts):
//   SDA25  a tool status move that is not allowed, a change to a retired tool, or a configuration
//          change without a new version or outside `proposed` / `suspended`
import { defineMigration } from './define.js';

// Same formats as the Run Contract's tool grants (`@sdlc/contracts` tools.ts).
const VERSION_LABEL = `~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$'`;
const MODEL = `~ '^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$'`;
// Ports 1–65535, as `BACKING_SERVICE_PATTERN`.
const BACKING_SERVICE = `'^[a-z][a-z0-9-]{0,62}:([1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])$'`;
// The permission catalogue of `@sdlc/contracts` (a new permission needs an ADR and a migration).
const PERMISSIONS = `ARRAY['read_documents']`;

const CONFIG_COLUMNS = [
  'transport',
  'image_ref',
  'image_digest',
  'permissions',
  'allowed_data_classes',
  'backing_services',
  'model_ref',
];

export const migration0038ToolRegister = defineMigration({
  up: [
    // PostgreSQL 12+ allows ADD VALUE in a transaction; the value is not used in this one.
    `ALTER TYPE gate_reason_code ADD VALUE 'tool_not_runnable' BEFORE 'other'`,
    `CREATE FUNCTION tool_codes_are_distinct(codes text[], pattern text, max_count integer)
       RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
       SELECT cardinality(codes) <= max_count
         AND array_position(codes, NULL) IS NULL
         AND NOT EXISTS (SELECT 1 FROM unnest(codes) AS c(code) WHERE c.code !~ pattern)
         AND cardinality(codes) = (SELECT count(DISTINCT c.code) FROM unnest(codes) AS c(code))
     $$`,
    `ALTER TABLE plans DROP CONSTRAINT plans_allowed_tools_check`,
    `ALTER TABLE plans ADD CONSTRAINT plans_allowed_tools_check CHECK (allowed_tools IS NULL OR (
       cardinality(allowed_tools) >= 1
       AND tool_codes_are_distinct(allowed_tools,
         '^(file_editor|task_tracker|terminal|tool:[a-z][a-z0-9-]{1,62})$', 13)))`,
    `CREATE TYPE tool_status AS ENUM ('proposed', 'active', 'suspended', 'quarantined', 'retired')`,
    `CREATE TABLE tools (
       id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id            uuid NOT NULL,
       tool_key             text NOT NULL CHECK (tool_key ~ '^[a-z][a-z0-9-]{1,62}$'),
       version              text NOT NULL CHECK (version ${VERSION_LABEL}),
       status               tool_status NOT NULL DEFAULT 'proposed',
       owner_id             uuid NOT NULL,
       transport            text NOT NULL CHECK (transport IN ('http', 'stdio')),
       -- The image name without a digest; the digest is its own column (R038).
       image_ref            text CHECK (image_ref ~ '^[a-z0-9][a-z0-9._/:-]{0,254}$'),
       image_digest         text CHECK (image_digest ~ '^sha256:[0-9a-f]{64}$'),
       permissions          text[] NOT NULL CHECK (
                              cardinality(permissions) >= 1
                              AND permissions <@ ${PERMISSIONS}
                              AND tool_codes_are_distinct(permissions, '^[a-z_]+$', 10)),
       allowed_data_classes data_class[] NOT NULL DEFAULT '{}' CHECK (
                              NOT ('prohibited' = ANY (allowed_data_classes))
                              AND tool_codes_are_distinct(
                                allowed_data_classes::text[], '^[a-z_]+$', 5)),
       backing_services     text[] NOT NULL DEFAULT '{}' CHECK (
                              tool_codes_are_distinct(backing_services, ${BACKING_SERVICE}, 10)),
       -- The gateway model the tool calls, if any (ADR-M69 §2.2, D-07 §4): a pinned version.
       model_ref            text CHECK (
                              model_ref ${MODEL} AND model_ref ~ '[0-9]' AND model_ref !~* 'latest'),
       last_recertified_at  date,
       updated_at           timestamptz NOT NULL DEFAULT now(),
       created_at           timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT tools_tenant_id_id_key UNIQUE (tenant_id, id),
       -- Retired tools keep their key: an identity is never reused.
       CONSTRAINT tools_tenant_id_tool_key_key UNIQUE (tenant_id, tool_key),
       CONSTRAINT tools_owner_fkey FOREIGN KEY (tenant_id, owner_id)
         REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT tools_http_has_image CHECK ((transport = 'http') = (image_ref IS NOT NULL)),
       CONSTRAINT tools_stdio_is_alone CHECK (
         transport <> 'stdio' OR (image_digest IS NULL AND cardinality(backing_services) = 0)),
       -- Only a tool with a pinned image and a certification date may run (ADR-M69 §2.2).
       CONSTRAINT tools_active_is_pinned CHECK (
         status <> 'active' OR (
           last_recertified_at IS NOT NULL AND (transport <> 'http' OR image_digest IS NOT NULL)))
     )`,
    `CREATE FUNCTION tools_changes() RETURNS trigger
       LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
     BEGIN
       IF OLD.status = 'retired' THEN
         RAISE EXCEPTION 'tool %: retired', OLD.id USING ERRCODE = 'SDA25';
       END IF;
       IF NEW.status <> OLD.status AND NOT (
            (OLD.status = 'proposed'    AND NEW.status IN ('active', 'retired'))
         OR (OLD.status = 'active'      AND NEW.status IN ('suspended', 'quarantined', 'retired'))
         OR (OLD.status = 'suspended'   AND NEW.status IN ('active', 'quarantined', 'retired'))
         OR (OLD.status = 'quarantined' AND NEW.status IN ('suspended', 'retired'))) THEN
         RAISE EXCEPTION 'tool %: status % cannot become %', OLD.id, OLD.status, NEW.status
           USING ERRCODE = 'SDA25';
       END IF;
       IF NEW.version IS DISTINCT FROM OLD.version
          OR ${CONFIG_COLUMNS.map((c) => `NEW.${c} IS DISTINCT FROM OLD.${c}`).join('\n          OR ')}
       THEN
         IF OLD.status NOT IN ('proposed', 'suspended') OR NEW.status <> OLD.status
            OR NEW.version = OLD.version THEN
           RAISE EXCEPTION 'tool %: configuration changes need a new version while proposed or suspended',
             OLD.id USING ERRCODE = 'SDA25';
         END IF;
       END IF;
       IF NEW.last_recertified_at IS DISTINCT FROM OLD.last_recertified_at
          AND (NEW.last_recertified_at IS NULL OR NEW.last_recertified_at < OLD.last_recertified_at) THEN
         RAISE EXCEPTION 'tool %: the recertification date never goes back', OLD.id
           USING ERRCODE = 'SDA25';
       END IF;
       RETURN NEW;
     END $$`,
    `CREATE TRIGGER tools_changes BEFORE UPDATE ON tools
       FOR EACH ROW EXECUTE FUNCTION tools_changes()`,
    `REVOKE ALL ON tools FROM PUBLIC`,
    `GRANT SELECT, INSERT ON tools TO platform_app`,
    // State, owner and configuration; the identity (`tool_key`, `tenant_id`) never changes.
    `GRANT UPDATE (version, status, owner_id, ${CONFIG_COLUMNS.join(', ')},
       last_recertified_at, updated_at) ON tools TO platform_app`,

    `CREATE TABLE tool_approvals (
       id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id    uuid NOT NULL,
       tool_id      uuid NOT NULL,
       tool_version text NOT NULL CHECK (tool_version ${VERSION_LABEL}),
       purpose      text NOT NULL CHECK (purpose IN ('activate', 'retire')),
       capacity     text NOT NULL CHECK (capacity IN ('owner', 'person_a', 'person_b', 'governance')),
       approver_id  uuid NOT NULL,
       round_at     timestamptz NOT NULL,
       created_at   timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT tool_approvals_tool_fkey FOREIGN KEY (tenant_id, tool_id)
         REFERENCES tools (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT tool_approvals_approver_fkey FOREIGN KEY (tenant_id, approver_id)
         REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT tool_approvals_one_per_person
         UNIQUE (tenant_id, tool_id, purpose, round_at, approver_id),
       CONSTRAINT tool_approvals_one_per_capacity
         UNIQUE (tenant_id, tool_id, purpose, round_at, capacity)
     )`,
    `CREATE TRIGGER tool_approvals_no_update_delete BEFORE UPDATE OR DELETE ON tool_approvals
       FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`,
    `CREATE TRIGGER tool_approvals_no_truncate BEFORE TRUNCATE ON tool_approvals
       FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()`,
    `REVOKE ALL ON tool_approvals FROM PUBLIC`,
    `GRANT SELECT, INSERT ON tool_approvals TO platform_app`,
  ],
  // Development only (ADR-M09). An enum value cannot be dropped: `tool_not_runnable` stays.
  down: [
    `ALTER TABLE plans DROP CONSTRAINT plans_allowed_tools_check`,
    `ALTER TABLE plans ADD CONSTRAINT plans_allowed_tools_check CHECK (allowed_tools IS NULL OR (
       cardinality(allowed_tools) BETWEEN 1 AND 3
       AND allowed_tools <@ ARRAY['file_editor', 'task_tracker', 'terminal']::text[]))`,
    `DROP TABLE tool_approvals`,
    `DROP TABLE tools`,
    `DROP FUNCTION tools_changes()`,
    `DROP FUNCTION tool_codes_are_distinct(text[], text, integer)`,
    `DROP TYPE tool_status`,
  ],
});
