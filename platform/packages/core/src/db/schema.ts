// Kysely types for the `platform` database (design/D-05 sections 6.1–6.3 and 6.7; A06, A07, B02).
// Written by hand. `TABLE_COLUMNS` mirrors them at runtime; the integration tests compare both
// with the live schema, so the types cannot drift from the migrations.
import type {
  ActorType,
  AutonomyLevel,
  ChangeFlag,
  DataClass,
  EventSource,
  GateCheckMode,
  GateCode,
  GateDecision,
  GateReasonCode,
  IntentStatus,
  ProjectRole,
  RiskTier,
} from '@sdlc/contracts';
import type { ColumnType, Generated, Insertable, Selectable } from 'kysely';

import type {
  AiAllowed,
  DisclosureFormat,
  GateDecisionSource,
  GitProvider,
  ProdLogsAllowed,
  ProjectStatus,
  SpecSourceTool,
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

/**
 * Append-only audit log with a per-tenant hash chain (D-05 sections 6.7 and 7, ADR-M09 section
 * 2.8). Rows are only ever inserted, through `AuditLogRepository.append`.
 */
export interface AuditLogTable {
  /** bigint identity; `pg` returns int8 as a string. */
  id: ColumnType<string, never, never>;
  tenant_id: Immutable<string>;
  /** bigint, continuous per tenant from 1; `pg` returns int8 as a string. */
  seq: ColumnType<string, number, never>;
  hash_version: Immutable<number>;
  actor_type: Immutable<ActorType>;
  actor_id: Immutable<string | null>;
  action: Immutable<string>;
  entity_type: Immutable<string | null>;
  entity_id: Immutable<string | null>;
  /** IDs, codes, hashes and versions only; never personal or client data (ADR-M09 §2.8). */
  payload: ColumnType<Record<string, unknown>, string, never>;
  prev_hash: Immutable<string>;
  hash: Immutable<string>;
  occurred_at: Immutable<Date>;
  created_at: CreatedAt;
}

/**
 * An intent: the only registry table that is updated (current state). History lives in
 * `gate_decisions` and `audit_log` (D-05 section 6.2).
 */
export interface IntentsTable {
  id: GeneratedId;
  tenant_id: Immutable<string>;
  /** `INT-YYYY-NNNN`, unique within the tenant (D-02 FR-01). */
  code: Immutable<string>;
  project_id: Immutable<string>;
  title: Immutable<string>;
  description: Immutable<string>;
  created_by: Immutable<string>;
  risk_tier: Immutable<RiskTier>;
  data_class: Immutable<DataClass>;
  /** Computed by the policy engine at creation (D-02 FR-03). */
  max_autonomy: Immutable<AutonomyLevel>;
  budget_usd: ColumnType<string, string, never>;
  current_gate: ColumnType<GateCode | null, never, GateCode | null>;
  status: ColumnType<IntentStatus, never, IntentStatus>;
  issue_number: ColumnType<number | null, number | null, number | null>;
  pr_number: ColumnType<number | null, number | null, number | null>;
  updated_at: ColumnType<Date, never, Date>;
  created_at: CreatedAt;
}

/** A spec linked to an intent: path, commit and content hash, one row per version (FR-02). */
export interface SpecRefsTable {
  id: GeneratedId;
  tenant_id: Immutable<string>;
  intent_id: Immutable<string>;
  version: Immutable<number>;
  path: Immutable<string>;
  commit_sha: Immutable<string>;
  content_sha256: Immutable<string>;
  source_tool: Immutable<SpecSourceTool | null>;
  created_at: CreatedAt;
}

/** A plan for an intent, one row per version. `change_flags` drive G3 and G7 oversight. */
export interface PlansTable {
  id: GeneratedId;
  tenant_id: Immutable<string>;
  intent_id: Immutable<string>;
  version: Immutable<number>;
  planned_files: Immutable<string[]>;
  summary: Immutable<string>;
  plan_sha256: Immutable<string>;
  proposed_by_type: Immutable<ActorType>;
  change_flags: Immutable<ChangeFlag[]>;
  created_at: CreatedAt;
}

/**
 * Append-only gate decisions (D-05 section 6.3, ADR-M20). Codes, hashes and IDs only: the human
 * explanation stays on the Git host (`reason_ref`).
 */
export interface GateDecisionsTable {
  id: GeneratedId;
  tenant_id: Immutable<string>;
  intent_id: Immutable<string>;
  gate: Immutable<GateCode>;
  decision: Immutable<GateDecision>;
  /** Resolved from the matrix at decision time; `POLICY` only for the automatic G4 check. */
  oversight_mode: Immutable<GateCheckMode>;
  approver_role: Immutable<ProjectRole | null>;
  actor_type: Immutable<ActorType>;
  decided_by: Immutable<string | null>;
  reason_code: Immutable<GateReasonCode | null>;
  reason_ref: Immutable<string | null>;
  /** The bound version: hash of the gate's input (spec, plan, diff…). */
  input_sha256: Immutable<string>;
  scope: ColumnType<Record<string, unknown> | null, string | null, never>;
  expires_at: Immutable<Date | null>;
  config_hash: Immutable<string>;
  source: Immutable<GateDecisionSource>;
  event_source: Immutable<EventSource | null>;
  waited_seconds: Immutable<number | null>;
  /** Set on `void` decisions only: the approval they cancel. */
  voids_decision_id: Immutable<string | null>;
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
  audit_log: AuditLogTable;
  intents: IntentsTable;
  spec_refs: SpecRefsTable;
  plans: PlansTable;
  gate_decisions: GateDecisionsTable;
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
  audit_log: columns<AuditLogTable>()([
    'id',
    'tenant_id',
    'seq',
    'hash_version',
    'actor_type',
    'actor_id',
    'action',
    'entity_type',
    'entity_id',
    'payload',
    'prev_hash',
    'hash',
    'occurred_at',
    'created_at',
  ]),
  intents: columns<IntentsTable>()([
    'id',
    'tenant_id',
    'code',
    'project_id',
    'title',
    'description',
    'created_by',
    'risk_tier',
    'data_class',
    'max_autonomy',
    'budget_usd',
    'current_gate',
    'status',
    'issue_number',
    'pr_number',
    'updated_at',
    'created_at',
  ]),
  spec_refs: columns<SpecRefsTable>()([
    'id',
    'tenant_id',
    'intent_id',
    'version',
    'path',
    'commit_sha',
    'content_sha256',
    'source_tool',
    'created_at',
  ]),
  plans: columns<PlansTable>()([
    'id',
    'tenant_id',
    'intent_id',
    'version',
    'planned_files',
    'summary',
    'plan_sha256',
    'proposed_by_type',
    'change_flags',
    'created_at',
  ]),
  gate_decisions: columns<GateDecisionsTable>()([
    'id',
    'tenant_id',
    'intent_id',
    'gate',
    'decision',
    'oversight_mode',
    'approver_role',
    'actor_type',
    'decided_by',
    'reason_code',
    'reason_ref',
    'input_sha256',
    'scope',
    'expires_at',
    'config_hash',
    'source',
    'event_source',
    'waited_seconds',
    'voids_decision_id',
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
  audit_log: 'tenant_id',
  intents: 'tenant_id',
  spec_refs: 'tenant_id',
  plans: 'tenant_id',
  gate_decisions: 'tenant_id',
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
export type AuditLogRow = Selectable<AuditLogTable>;
export type Intent = Selectable<IntentsTable>;
export type SpecRef = Selectable<SpecRefsTable>;
export type Plan = Selectable<PlansTable>;
export type GateDecisionRow = Selectable<GateDecisionsTable>;

/** Insert input for a tenant table: the scope sets `tenant_id`, so callers never pass it. */
export type TenantInsert<T extends Exclude<TableName, 'tenants'>> = Omit<
  Insertable<Database[T]>,
  'tenant_id'
>;
