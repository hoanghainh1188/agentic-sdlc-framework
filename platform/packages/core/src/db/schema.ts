// Kysely types for the `platform` database (design/D-05 sections 6.1–6.5 and 6.7; A06, A07, B02,
// C02, C03).
// Written by hand. `TABLE_COLUMNS` mirrors them at runtime; the integration tests compare both
// with the live schema, so the types cannot drift from the migrations.
import type {
  ActorType,
  AgentStatus,
  AutonomyLevel,
  ChangeFlag,
  DataClass,
  EscalationRoute,
  EscalationStatus,
  EscalationStep,
  EscalationTrigger,
  EventSource,
  GateCheckMode,
  GateCode,
  GateDecision,
  GateReasonCode,
  IntentStatus,
  ProjectRole,
  ProviderType,
  ResponseLevel,
  RiskTier,
  RunStatus,
  Severity,
} from '@sdlc/contracts';
import type { ColumnType, Generated, Insertable, Selectable } from 'kysely';

import type {
  AgentEnvironment,
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
/**
 * `created_at` written from the escalation clock when given, so that the workflow compares it
 * with the intent's `gate_entered_at` on one clock (B07 session 2).
 */
type ClockedCreatedAt = ColumnType<Date, Date | undefined, never>;
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
  prod_logs_allowed: ProdLogsAllowed;
  disclosure_format: DisclosureFormat;
  /** When the client confirmed in writing; null while consent is unknown. SQL `date`, `YYYY-MM-DD`. */
  confirmed_at: string | null;
  updated_by: string;
  created_at: CreatedAt;
  /** `https://` link to the human AI record (template T7), which holds the free text (B12). */
  record_ref: string | null;
  /** SHA-256 of the canonical coded record (ADR-M32 §2.2). */
  record_sha256: string;
}

/** Every version of a project AI record, append-only, written by a trigger (B12, ADR-M32). */
export interface ProjectAiRecordVersionsTable {
  tenant_id: Immutable<string>;
  project_id: Immutable<string>;
  version: Immutable<number>;
  ai_allowed: Immutable<AiAllowed>;
  allowed_data_classes: Immutable<DataClass[]>;
  prod_logs_allowed: Immutable<ProdLogsAllowed>;
  disclosure_format: Immutable<DisclosureFormat>;
  confirmed_at: Immutable<string | null>;
  record_ref: Immutable<string | null>;
  record_sha256: Immutable<string>;
  updated_by: Immutable<string>;
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
  /**
   * When the intent last entered its current gate (migration 0009, B07). Decisions count only when
   * recorded after it; it also gives the gate's waiting time (FR-12).
   */
  gate_entered_at: ColumnType<Date | null, never, Date | null>;
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

/**
 * An agent run (D-05 section 6.4). Identity and inputs never change; `platform_app` may update the
 * state columns only, and the database refuses any change once the status is final (ADR-M22).
 */
export interface RunsTable {
  /** Generated by the issuer, so the Run Contract can be signed before the insert. */
  id: Immutable<string>;
  tenant_id: Immutable<string>;
  intent_id: Immutable<string>;
  plan_id: Immutable<string>;
  attempt: Immutable<number>;
  /** Registered agent (C10 adds the foreign key, QUESTIONS.md #32). */
  agent_id: Immutable<string>;
  agent_version: Immutable<string>;
  branch: Immutable<string>;
  base_sha: Immutable<string>;
  head_sha: ColumnType<string | null, string | null, string | null>;
  status: ColumnType<RunStatus, RunStatus | undefined, RunStatus>;
  /** A code, never free text. */
  stop_reason: ColumnType<string | null, string | null, string | null>;
  triggered_by: Immutable<string | null>;
  started_at: ColumnType<Date | null, Date | null, Date | null>;
  finished_at: ColumnType<Date | null, Date | null, Date | null>;
  iterations: ColumnType<number, number | undefined, number>;
  killed_by: ColumnType<string | null, string | null, string | null>;
  updated_at: ColumnType<Date, never, Date>;
  created_at: CreatedAt;
}

/** The signed Run Contract of a run (D-03 section 8, D-05 section 6.4). Written once. */
export interface RunContractsTable {
  run_id: Immutable<string>;
  tenant_id: Immutable<string>;
  /** The unsigned contract; its RFC 8785 canonical JSON is what was signed. */
  contract_json: ColumnType<Record<string, unknown>, string, never>;
  contract_sha256: Immutable<string>;
  /** Transit signature `vault:v<N>:…`. */
  signature: Immutable<string>;
  key_version: Immutable<number>;
  issued_at: Immutable<Date>;
  expires_at: Immutable<Date>;
  revoked_at: ColumnType<Date | null, never, never>;
  created_at: CreatedAt;
}

/**
 * Append-only run events (D-05 section 6.4). Coded payloads only: the fields declared per event
 * type in `RUN_EVENT_TYPES`; never free text or personal or client data (ADR-M22).
 */
export interface RunEventsTable {
  /** bigint identity; `pg` returns int8 as a string. */
  id: ColumnType<string, never, never>;
  tenant_id: Immutable<string>;
  run_id: Immutable<string>;
  event_type: Immutable<string>;
  payload: ColumnType<Record<string, unknown>, string, never>;
  created_at: CreatedAt;
}

/**
 * Receipts of Git host events handled by the poller (D-05 section 6.1b, ADR-M27): one row per
 * command comment, unique per event ID, and the outbox of its reply. Codes and IDs only.
 */
export interface GitEventReceiptsTable {
  /** bigint identity; `pg` returns int8 as a string. */
  id: ColumnType<string, never, never>;
  tenant_id: Immutable<string>;
  project_id: Immutable<string>;
  event_id: Immutable<string>;
  outcome: ColumnType<string, string, string>;
  gate_decision_id: ColumnType<string | null, string | null | undefined, string | null>;
  /** The escalation a `/ack` or `/decide` comment acted on (B11, migration 0007). */
  escalation_id: ColumnType<string | null, string | null | undefined, string | null>;
  issue_number: ColumnType<number | null, number | null | undefined, never>;
  reply_code: ColumnType<string | null, string | null | undefined, string | null>;
  reply_params: ColumnType<Record<string, string> | null, string | null | undefined, string | null>;
  event_attempts: ColumnType<number, number | undefined, number>;
  reply_attempts: ColumnType<number, number | undefined, number>;
  reply_posted_at: ColumnType<Date | null, never, Date>;
  reply_abandoned_at: ColumnType<Date | null, never, Date>;
  created_at: CreatedAt;
}

/**
 * Append-only cost records (D-05 section 6.5, ADR-M24): one row per model call, synced from the
 * gateway. Codes, IDs and numbers only.
 */
export interface CostRecordsTable {
  /** bigint identity; `pg` returns int8 as a string. */
  id: ColumnType<string, never, never>;
  tenant_id: Immutable<string>;
  project_id: Immutable<string>;
  intent_id: ColumnType<string | null, string | null, never>;
  run_id: ColumnType<string | null, string | null, never>;
  gate: ColumnType<GateCode | null, GateCode | null, never>;
  agent: ColumnType<string | null, string | null, never>;
  model: Immutable<string>;
  provider_type: Immutable<ProviderType>;
  /** bigint: `pg` returns int8 as a string. */
  input_tokens: ColumnType<string, number, never>;
  output_tokens: ColumnType<string, number, never>;
  cached_input_tokens: ColumnType<string, number, never>;
  cost_usd: ColumnType<string, string, never>;
  source_ref: Immutable<string>;
  occurred_at: Immutable<Date>;
  created_at: CreatedAt;
}

type Mutable<T> = ColumnType<T, T | undefined, T>;
type MutableNullable<T> = ColumnType<T | null, T | null | undefined, T | null>;

/**
 * Escalations (D-05 section 6.4b, ADR-M28). Kept at least 2 years: codes, IDs, hashes and
 * references only. `platform_app` updates the state, clock, acknowledgement and decision columns;
 * a trigger allows only the status moves of ADR-M28 and refuses any change once `closed`.
 */
export interface EscalationsTable {
  id: GeneratedId;
  tenant_id: Immutable<string>;
  code: Immutable<string>;
  intent_id: Immutable<string>;
  run_id: ColumnType<string | null, string | null | undefined, never>;
  trigger: Immutable<EscalationTrigger>;
  route: Immutable<EscalationRoute>;
  severity: Immutable<Severity>;
  response_level: Immutable<ResponseLevel>;
  /** Flat coded object (`EscalationPacket`); stored as JSON text on insert. */
  packet: ColumnType<Record<string, unknown>, string, never>;
  producer_ids: ColumnType<string[], string[] | undefined, never>;
  owner_id: ColumnType<string | null, string | null | undefined, never>;
  backup_owner_id: MutableNullable<string>;
  current_step: Mutable<EscalationStep>;
  status: Mutable<EscalationStatus>;
  ack_due_at: Immutable<Date>;
  step_due_at: Mutable<Date>;
  remind_at: MutableNullable<Date>;
  reminded_step: MutableNullable<EscalationStep>;
  ack_missed_at: MutableNullable<Date>;
  governance_overdue_at: MutableNullable<Date>;
  resolve_due_at: MutableNullable<Date>;
  resolve_overdue_at: MutableNullable<Date>;
  next_check_at: MutableNullable<Date>;
  acknowledged_by: MutableNullable<string>;
  acknowledged_at: MutableNullable<Date>;
  decision: ColumnType<Record<string, unknown> | null, string | null | undefined, string | null>;
  decided_by: MutableNullable<string>;
  decided_at: MutableNullable<Date>;
  closed_at: MutableNullable<Date>;
  updated_at: ColumnType<Date, never, Date>;
  created_at: ClockedCreatedAt;
}

/** Outbox of escalation notices (ADR-M28 §2.5): codes only; PR 2 of B11 posts them. */
export interface EscalationNoticesTable {
  /** bigint identity; `pg` returns int8 as a string. */
  id: ColumnType<string, never, never>;
  tenant_id: Immutable<string>;
  escalation_id: Immutable<string>;
  kind: Immutable<string>;
  step: Immutable<EscalationStep>;
  audience_role: Immutable<ProjectRole>;
  attempts: ColumnType<number, number | undefined, number>;
  posted_at: ColumnType<Date | null, never, Date>;
  abandoned_at: ColumnType<Date | null, never, Date>;
  created_at: CreatedAt;
}

/**
 * The agent register (D-05 section 6.1, task C10, ADR-M31). Codes only; rows are never deleted. A
 * trigger allows only the status moves of handbook Ch.20 and configuration changes with a new
 * version while `proposed` or `suspended`.
 */
export interface AgentsTable {
  id: GeneratedId;
  tenant_id: Immutable<string>;
  agent_key: Immutable<string>;
  version: string;
  status: Mutable<AgentStatus>;
  owner_id: string;
  model_ref: MutableNullable<string>;
  instructions_ref: string;
  instructions_sha256: string;
  allowed_tools: Mutable<string[]>;
  max_autonomy: AutonomyLevel;
  approved_environments: Mutable<AgentEnvironment[]>;
  /** SQL `date`, kept as a `YYYY-MM-DD` string (connection.ts). */
  last_recertified_at: MutableNullable<string>;
  updated_at: ColumnType<Date, never, Date>;
  created_at: CreatedAt;
}

/** Outbox of the gate status comments (FR-22, B07, ADR-M30): codes and IDs only. */
export interface IntentNoticesTable {
  /** bigint identity; `pg` returns int8 as a string. */
  id: ColumnType<string, never, never>;
  tenant_id: Immutable<string>;
  intent_id: Immutable<string>;
  kind: Immutable<string>;
  status: Immutable<IntentStatus>;
  gate: Immutable<GateCode | null>;
  previous_gate: Immutable<GateCode | null>;
  /** The gate decision that caused the change; null when none did (the intent was submitted). */
  decision_id: Immutable<string | null>;
  /** Roles mentioned in the comment: the people who act next. Never `viewer`. */
  audience_roles: ColumnType<ProjectRole[], ProjectRole[] | undefined, never>;
  /** The agent a notice is about (C06: the recertification warning mentions its owner). */
  agent_id: ColumnType<string | null, string | null | undefined, never>;
  attempts: ColumnType<number, number | undefined, number>;
  posted_at: ColumnType<Date | null, never, Date>;
  abandoned_at: ColumnType<Date | null, never, Date>;
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
  runs: RunsTable;
  run_contracts: RunContractsTable;
  run_events: RunEventsTable;
  cost_records: CostRecordsTable;
  git_event_receipts: GitEventReceiptsTable;
  escalations: EscalationsTable;
  escalation_notices: EscalationNoticesTable;
  agents: AgentsTable;
  intent_notices: IntentNoticesTable;
  project_ai_record_versions: ProjectAiRecordVersionsTable;
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
    'prod_logs_allowed',
    'disclosure_format',
    'confirmed_at',
    'updated_by',
    'created_at',
    'record_ref',
    'record_sha256',
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
    'gate_entered_at',
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
  runs: columns<RunsTable>()([
    'id',
    'tenant_id',
    'intent_id',
    'plan_id',
    'attempt',
    'agent_id',
    'agent_version',
    'branch',
    'base_sha',
    'head_sha',
    'status',
    'stop_reason',
    'triggered_by',
    'started_at',
    'finished_at',
    'iterations',
    'killed_by',
    'updated_at',
    'created_at',
  ]),
  run_contracts: columns<RunContractsTable>()([
    'run_id',
    'tenant_id',
    'contract_json',
    'contract_sha256',
    'signature',
    'key_version',
    'issued_at',
    'expires_at',
    'revoked_at',
    'created_at',
  ]),
  run_events: columns<RunEventsTable>()([
    'id',
    'tenant_id',
    'run_id',
    'event_type',
    'payload',
    'created_at',
  ]),
  cost_records: columns<CostRecordsTable>()([
    'id',
    'tenant_id',
    'project_id',
    'intent_id',
    'run_id',
    'gate',
    'agent',
    'model',
    'provider_type',
    'input_tokens',
    'output_tokens',
    'cached_input_tokens',
    'cost_usd',
    'source_ref',
    'occurred_at',
    'created_at',
  ]),
  git_event_receipts: columns<GitEventReceiptsTable>()([
    'id',
    'tenant_id',
    'project_id',
    'event_id',
    'outcome',
    'gate_decision_id',
    'issue_number',
    'reply_code',
    'reply_params',
    'event_attempts',
    'reply_attempts',
    'reply_posted_at',
    'reply_abandoned_at',
    'created_at',
    'escalation_id',
  ]),
  escalations: columns<EscalationsTable>()([
    'id',
    'tenant_id',
    'code',
    'intent_id',
    'run_id',
    'trigger',
    'route',
    'severity',
    'response_level',
    'packet',
    'producer_ids',
    'owner_id',
    'backup_owner_id',
    'current_step',
    'status',
    'ack_due_at',
    'step_due_at',
    'remind_at',
    'reminded_step',
    'ack_missed_at',
    'governance_overdue_at',
    'resolve_due_at',
    'resolve_overdue_at',
    'next_check_at',
    'acknowledged_by',
    'acknowledged_at',
    'decision',
    'decided_by',
    'decided_at',
    'closed_at',
    'updated_at',
    'created_at',
  ]),
  escalation_notices: columns<EscalationNoticesTable>()([
    'id',
    'tenant_id',
    'escalation_id',
    'kind',
    'step',
    'audience_role',
    'attempts',
    'posted_at',
    'abandoned_at',
    'created_at',
  ]),
  agents: columns<AgentsTable>()([
    'id',
    'tenant_id',
    'agent_key',
    'version',
    'status',
    'owner_id',
    'model_ref',
    'instructions_ref',
    'instructions_sha256',
    'allowed_tools',
    'max_autonomy',
    'approved_environments',
    'last_recertified_at',
    'updated_at',
    'created_at',
  ]),
  intent_notices: columns<IntentNoticesTable>()([
    'id',
    'tenant_id',
    'intent_id',
    'kind',
    'status',
    'gate',
    'previous_gate',
    'decision_id',
    'audience_roles',
    'attempts',
    'posted_at',
    'abandoned_at',
    'created_at',
    'agent_id',
  ]),
  project_ai_record_versions: columns<ProjectAiRecordVersionsTable>()([
    'tenant_id',
    'project_id',
    'version',
    'ai_allowed',
    'allowed_data_classes',
    'prod_logs_allowed',
    'disclosure_format',
    'confirmed_at',
    'record_ref',
    'record_sha256',
    'updated_by',
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
  runs: 'tenant_id',
  run_contracts: 'tenant_id',
  run_events: 'tenant_id',
  cost_records: 'tenant_id',
  git_event_receipts: 'tenant_id',
  escalations: 'tenant_id',
  escalation_notices: 'tenant_id',
  agents: 'tenant_id',
  intent_notices: 'tenant_id',
  project_ai_record_versions: 'tenant_id',
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
export type Run = Selectable<RunsTable>;
export type RunContractRow = Selectable<RunContractsTable>;
export type RunEventRow = Selectable<RunEventsTable>;
export type CostRecordRow = Selectable<CostRecordsTable>;
export type GitEventReceipt = Selectable<GitEventReceiptsTable>;
export type Escalation = Selectable<EscalationsTable>;
export type EscalationNotice = Selectable<EscalationNoticesTable>;
export type Agent = Selectable<AgentsTable>;
export type IntentNotice = Selectable<IntentNoticesTable>;
export type ProjectAiRecordVersion = Selectable<ProjectAiRecordVersionsTable>;

/** Insert input for a tenant table: the scope sets `tenant_id`, so callers never pass it. */
export type TenantInsert<T extends Exclude<TableName, 'tenants'>> = Omit<
  Insertable<Database[T]>,
  'tenant_id'
>;
