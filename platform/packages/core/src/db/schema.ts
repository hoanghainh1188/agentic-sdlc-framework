// Kysely types for the `platform` database (design/D-05 section 6.1, task A06).
// Written by hand. `TABLE_COLUMNS` mirrors them at runtime; the integration tests compare both
// with the live schema, so the types cannot drift from the migrations.
import type { DataClass, ProjectRole } from '@sdlc/contracts';
import type { ColumnType, Generated, Insertable, Selectable } from 'kysely';

import type {
  AiAllowed,
  DisclosureFormat,
  GitProvider,
  ProdLogsAllowed,
  ProjectStatus,
  TenantStatus,
  UserStatus,
} from './vocabulary.js';

type CreatedAt = ColumnType<Date, never, never>;
/** Set by the database on insert; never changed afterwards. */
type Immutable<T> = ColumnType<T, T, never>;
type GeneratedId = ColumnType<string, never, never>;
/** numeric(18,6): returned as a string by `pg`, so money never goes through floating point (D-05 D6). */
type Money = ColumnType<string, string | null, string | null>;

export interface TenantsTable {
  id: GeneratedId;
  slug: Immutable<string>;
  name: string;
  monthly_budget_usd: Money | null;
  status: Generated<TenantStatus>;
  created_at: CreatedAt;
}

export interface ProjectsTable {
  id: GeneratedId;
  tenant_id: Immutable<string>;
  slug: Immutable<string>;
  name: string;
  git_provider: Immutable<GitProvider>;
  repo_full_name: string;
  default_branch: Generated<string>;
  status: Generated<ProjectStatus>;
  created_at: CreatedAt;
}

export interface ProjectConfigsTable {
  project_id: Immutable<string>;
  tenant_id: Immutable<string>;
  version: number;
  config_yaml: string;
  config_hash: string;
  /** Null when the platform itself wrote the config (for example a default config). */
  updated_by: string | null;
  created_at: CreatedAt;
}

export interface ProjectAiRecordsTable {
  project_id: Immutable<string>;
  tenant_id: Immutable<string>;
  version: number;
  ai_allowed: AiAllowed;
  allowed_data_classes: DataClass[];
  allowed_tools_locations: string | null;
  prod_logs_allowed: ProdLogsAllowed;
  disclosure_format: DisclosureFormat;
  confirmed_by: string | null;
  /** SQL `date`, returned as `YYYY-MM-DD` (see connection.ts). */
  confirmed_at: string | null;
  updated_by: string;
  created_at: CreatedAt;
}

export interface UsersTable {
  id: GeneratedId;
  tenant_id: Immutable<string>;
  display_name: string;
  email: string;
  status: Generated<UserStatus>;
  created_at: CreatedAt;
}

export interface UserIdentitiesTable {
  id: GeneratedId;
  tenant_id: Immutable<string>;
  user_id: Immutable<string>;
  provider: Immutable<GitProvider>;
  /** Numeric account ID at the Git host, never the username (which can change). */
  external_id: Immutable<string>;
  external_login: string;
  created_at: CreatedAt;
}

export interface RoleBindingsTable {
  id: GeneratedId;
  tenant_id: Immutable<string>;
  user_id: Immutable<string>;
  project_id: Immutable<string>;
  role: Immutable<ProjectRole>;
  /** Set once when the role is withdrawn; never set on insert. Null = active. */
  revoked_at: ColumnType<Date | null, never, Date>;
  created_at: CreatedAt;
}

export interface ApiTokensTable {
  id: GeneratedId;
  tenant_id: Immutable<string>;
  user_id: Immutable<string>;
  name: Immutable<string>;
  /** SHA-256 of the token, lowercase hex. The token itself is never stored. */
  token_hash: Immutable<string>;
  last_used_at: Date | null;
  expires_at: Immutable<Date>;
  revoked_at: Date | null;
  created_at: CreatedAt;
}

export interface GitEventCursorsTable {
  project_id: Immutable<string>;
  tenant_id: Immutable<string>;
  cursor: string;
  last_polled_at: Date;
  created_at: CreatedAt;
}

export interface Database {
  tenants: TenantsTable;
  projects: ProjectsTable;
  project_configs: ProjectConfigsTable;
  project_ai_records: ProjectAiRecordsTable;
  users: UsersTable;
  user_identities: UserIdentitiesTable;
  role_bindings: RoleBindingsTable;
  api_tokens: ApiTokensTable;
  git_event_cursors: GitEventCursorsTable;
}

export type TableName = keyof Database;

type ColumnList<T> = readonly (keyof T & string)[];
type ExactColumns<T, L extends ColumnList<T>> =
  Exclude<keyof T, L[number]> extends never ? L : ['missing columns', Exclude<keyof T, L[number]>];

function columns<T>() {
  return <const L extends ColumnList<T>>(list: ExactColumns<T, L>): L => list as L;
}

/** Every column of every table, in migration order. Type-checked to match the interfaces above. */
export const TABLE_COLUMNS = {
  tenants: columns<TenantsTable>()([
    'id',
    'slug',
    'name',
    'monthly_budget_usd',
    'status',
    'created_at',
  ]),
  projects: columns<ProjectsTable>()([
    'id',
    'tenant_id',
    'slug',
    'name',
    'git_provider',
    'repo_full_name',
    'default_branch',
    'status',
    'created_at',
  ]),
  project_configs: columns<ProjectConfigsTable>()([
    'project_id',
    'tenant_id',
    'version',
    'config_yaml',
    'config_hash',
    'updated_by',
    'created_at',
  ]),
  project_ai_records: columns<ProjectAiRecordsTable>()([
    'project_id',
    'tenant_id',
    'version',
    'ai_allowed',
    'allowed_data_classes',
    'allowed_tools_locations',
    'prod_logs_allowed',
    'disclosure_format',
    'confirmed_by',
    'confirmed_at',
    'updated_by',
    'created_at',
  ]),
  users: columns<UsersTable>()([
    'id',
    'tenant_id',
    'display_name',
    'email',
    'status',
    'created_at',
  ]),
  user_identities: columns<UserIdentitiesTable>()([
    'id',
    'tenant_id',
    'user_id',
    'provider',
    'external_id',
    'external_login',
    'created_at',
  ]),
  role_bindings: columns<RoleBindingsTable>()([
    'id',
    'tenant_id',
    'user_id',
    'project_id',
    'role',
    'revoked_at',
    'created_at',
  ]),
  api_tokens: columns<ApiTokensTable>()([
    'id',
    'tenant_id',
    'user_id',
    'name',
    'token_hash',
    'last_used_at',
    'expires_at',
    'revoked_at',
    'created_at',
  ]),
  git_event_cursors: columns<GitEventCursorsTable>()([
    'project_id',
    'tenant_id',
    'cursor',
    'last_polled_at',
    'created_at',
  ]),
} as const satisfies { [T in TableName]: ColumnList<Database[T]> };

/**
 * The column that holds the tenant, per table (D-05 D1). `tenants` is the tenant itself.
 * The tenant guard rejects any table that is not listed here.
 */
export const TENANT_COLUMN = {
  tenants: 'id',
  projects: 'tenant_id',
  project_configs: 'tenant_id',
  project_ai_records: 'tenant_id',
  users: 'tenant_id',
  user_identities: 'tenant_id',
  role_bindings: 'tenant_id',
  api_tokens: 'tenant_id',
  git_event_cursors: 'tenant_id',
} as const satisfies { [T in TableName]: keyof Database[T] & string };

export type Tenant = Selectable<TenantsTable>;
export type Project = Selectable<ProjectsTable>;
export type ProjectConfig = Selectable<ProjectConfigsTable>;
export type ProjectAiRecord = Selectable<ProjectAiRecordsTable>;
export type User = Selectable<UsersTable>;
export type UserIdentity = Selectable<UserIdentitiesTable>;
export type RoleBinding = Selectable<RoleBindingsTable>;
export type ApiToken = Selectable<ApiTokensTable>;
export type GitEventCursor = Selectable<GitEventCursorsTable>;

/** Insert input for a tenant table: the scope sets `tenant_id`, so callers never pass it. */
export type TenantInsert<T extends Exclude<TableName, 'tenants'>> = Omit<
  Insertable<Database[T]>,
  'tenant_id'
>;
