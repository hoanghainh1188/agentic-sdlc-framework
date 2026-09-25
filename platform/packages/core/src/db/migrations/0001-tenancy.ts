// Migration 0001: tenancy tables (design/D-05 sections 5, 6.1 and 9; D-08 A06 AC2).
//
// Rules for every migration (design/ADR-M09-database-tooling.md):
// - Plain SQL. Once merged to main, a migration never changes; fix forward with a new one.
// - Every table except `tenants` has `tenant_id uuid NOT NULL` and `created_at`.
// - Parents have UNIQUE (tenant_id, id); children reference them with (tenant_id, <fk>) (D-05 D2).
// - ON DELETE RESTRICT everywhere: no hard deletes of business data (D-05 D7).
// - `platform_app` gets SELECT and INSERT, and UPDATE only on columns that may change.
//   Never DELETE or TRUNCATE. `id`, `tenant_id` and `created_at` are never updatable.
import { defineMigration } from './define.js';

const HEX64 = `~ '^[0-9a-f]{64}$'`;

export const migration0001Tenancy = defineMigration({
  up: [
    // The application role is created outside migrations (platform/deploy/postgres/init).
    `DO $$
     BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_app') THEN
         RAISE EXCEPTION 'role platform_app is missing; see design/ADR-M09-database-tooling.md section 2.3';
       END IF;
     END $$`,

    `CREATE TYPE data_class AS ENUM
       ('public', 'internal', 'client_confidential', 'client_restricted', 'prohibited')`,
    `CREATE TYPE project_role AS ENUM
       ('person_a', 'person_b', 'second_approver', 'pm_brse', 'governance', 'admin', 'viewer')`,
    `CREATE TYPE git_provider AS ENUM ('github', 'gitlab')`,

    `CREATE TABLE tenants (
       id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       slug               text NOT NULL,
       name               text NOT NULL,
       monthly_budget_usd numeric(18,6) CHECK (monthly_budget_usd >= 0),
       status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
       created_at         timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT tenants_slug_key UNIQUE (slug)
     )`,

    `CREATE TABLE projects (
       id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id      uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
       slug           text NOT NULL,
       name           text NOT NULL,
       git_provider   git_provider NOT NULL,
       repo_full_name text NOT NULL,
       default_branch text NOT NULL DEFAULT 'main',
       status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
       created_at     timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT projects_tenant_id_id_key UNIQUE (tenant_id, id),
       CONSTRAINT projects_tenant_id_slug_key UNIQUE (tenant_id, slug)
     )`,

    `CREATE TABLE users (
       id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id    uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
       display_name text NOT NULL,
       email        text NOT NULL,
       status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
       created_at   timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT users_tenant_id_id_key UNIQUE (tenant_id, id)
     )`,
    // Email is unique within the tenant, ignoring case.
    `CREATE UNIQUE INDEX users_tenant_id_email_key ON users (tenant_id, lower(email))`,

    `CREATE TABLE project_configs (
       project_id  uuid PRIMARY KEY,
       tenant_id   uuid NOT NULL,
       version     integer NOT NULL CHECK (version >= 1),
       config_yaml text NOT NULL,
       config_hash char(64) NOT NULL CHECK (config_hash ${HEX64}),
       updated_by  uuid,
       created_at  timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT project_configs_project_fkey FOREIGN KEY (tenant_id, project_id)
         REFERENCES projects (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT project_configs_updated_by_fkey FOREIGN KEY (tenant_id, updated_by)
         REFERENCES users (tenant_id, id) ON DELETE RESTRICT
     )`,

    `CREATE TABLE project_ai_records (
       project_id              uuid PRIMARY KEY,
       tenant_id               uuid NOT NULL,
       version                 integer NOT NULL CHECK (version >= 1),
       ai_allowed              text NOT NULL CHECK (ai_allowed IN ('no', 'yes', 'yes_with_conditions')),
       allowed_data_classes    data_class[] NOT NULL DEFAULT '{}',
       allowed_tools_locations text,
       prod_logs_allowed       text NOT NULL DEFAULT 'no' CHECK (prod_logs_allowed IN ('no', 'yes_masked')),
       disclosure_format       text NOT NULL CHECK (disclosure_format IN ('client_format', 'standard_note')),
       confirmed_by            text,
       confirmed_at            date,
       updated_by              uuid NOT NULL,
       created_at              timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT project_ai_records_project_fkey FOREIGN KEY (tenant_id, project_id)
         REFERENCES projects (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT project_ai_records_updated_by_fkey FOREIGN KEY (tenant_id, updated_by)
         REFERENCES users (tenant_id, id) ON DELETE RESTRICT
     )`,

    `CREATE TABLE user_identities (
       id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id      uuid NOT NULL,
       user_id        uuid NOT NULL,
       provider       git_provider NOT NULL,
       external_id    text NOT NULL,
       external_login text NOT NULL,
       created_at     timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT user_identities_user_fkey FOREIGN KEY (tenant_id, user_id)
         REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT user_identities_tenant_id_provider_external_id_key
         UNIQUE (tenant_id, provider, external_id)
     )`,

    `CREATE TABLE role_bindings (
       id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id  uuid NOT NULL,
       user_id    uuid NOT NULL,
       project_id uuid NOT NULL,
       role       project_role NOT NULL,
       created_at timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT role_bindings_user_fkey FOREIGN KEY (tenant_id, user_id)
         REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT role_bindings_project_fkey FOREIGN KEY (tenant_id, project_id)
         REFERENCES projects (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT role_bindings_tenant_id_user_id_project_id_role_key
         UNIQUE (tenant_id, user_id, project_id, role)
     )`,
    `CREATE INDEX role_bindings_tenant_id_project_id_idx ON role_bindings (tenant_id, project_id)`,

    `CREATE TABLE api_tokens (
       id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id    uuid NOT NULL,
       user_id      uuid NOT NULL,
       name         text NOT NULL,
       token_hash   char(64) NOT NULL CHECK (token_hash ${HEX64}),
       last_used_at timestamptz,
       expires_at   timestamptz NOT NULL,
       revoked_at   timestamptz,
       created_at   timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT api_tokens_user_fkey FOREIGN KEY (tenant_id, user_id)
         REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
       -- Unique across tenants: the tenant is found from the token (task B03).
       CONSTRAINT api_tokens_token_hash_key UNIQUE (token_hash),
       CONSTRAINT api_tokens_expires_after_creation CHECK (expires_at > created_at)
     )`,
    `CREATE INDEX api_tokens_tenant_id_user_id_idx ON api_tokens (tenant_id, user_id)`,

    `CREATE TABLE git_event_cursors (
       project_id     uuid PRIMARY KEY,
       tenant_id      uuid NOT NULL,
       cursor         text NOT NULL,
       last_polled_at timestamptz NOT NULL,
       created_at     timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT git_event_cursors_project_fkey FOREIGN KEY (tenant_id, project_id)
         REFERENCES projects (tenant_id, id) ON DELETE RESTRICT
     )`,

    // Privileges of the application role (ADR-M09 section 2.3).
    `REVOKE ALL ON tenants, projects, project_configs, project_ai_records, users, user_identities,
       role_bindings, api_tokens, git_event_cursors FROM PUBLIC`,
    `GRANT SELECT, INSERT ON tenants, projects, project_configs, project_ai_records, users,
       user_identities, role_bindings, api_tokens, git_event_cursors TO platform_app`,
    `GRANT UPDATE (name, monthly_budget_usd, status) ON tenants TO platform_app`,
    `GRANT UPDATE (name, repo_full_name, default_branch, status) ON projects TO platform_app`,
    `GRANT UPDATE (version, config_yaml, config_hash, updated_by) ON project_configs TO platform_app`,
    `GRANT UPDATE (version, ai_allowed, allowed_data_classes, allowed_tools_locations,
       prod_logs_allowed, disclosure_format, confirmed_by, confirmed_at, updated_by)
       ON project_ai_records TO platform_app`,
    `GRANT UPDATE (display_name, email, status) ON users TO platform_app`,
    `GRANT UPDATE (external_login) ON user_identities TO platform_app`,
    `GRANT UPDATE (last_used_at, revoked_at) ON api_tokens TO platform_app`,
    `GRANT UPDATE (cursor, last_polled_at) ON git_event_cursors TO platform_app`,
  ],
  down: [
    `DROP TABLE git_event_cursors, api_tokens, role_bindings, user_identities, project_ai_records,
       project_configs, users, projects, tenants`,
    `DROP TYPE git_provider, project_role, data_class`,
  ],
});
