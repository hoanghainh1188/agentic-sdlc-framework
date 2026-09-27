// Vocabularies stored as PostgreSQL enums and CHECK constraints (design/D-05 section 5).
// Canonical codes (data classes, 2+N roles, …) come from `@sdlc/contracts`; this file lists only
// the values that exist in the database layer alone. Only the enums used by existing tables exist
// yet (A06; `actor_type` from A07; the registry enums from B02; `run_status` from C02; the
// escalation enums from B11); later tasks add theirs with their
// tables.
// Changing a list needs a migration: design/ADR-M09-database-tooling.md section 2.5.
import {
  ACTOR_TYPES,
  AUTONOMY_LEVELS,
  CHANGE_FLAGS,
  DATA_CLASSES,
  EVENT_SOURCES,
  GATE_CHECK_MODES,
  GATE_CODES,
  GATE_DECISIONS,
  GATE_REASON_CODES,
  INTENT_STATUSES,
  PROJECT_ROLES,
  ESCALATION_ROUTES,
  ESCALATION_STATUSES,
  ESCALATION_STEPS,
  ESCALATION_TRIGGERS,
  RESPONSE_LEVELS,
  RISK_TIERS,
  RUN_STATUSES,
  SEVERITIES,
} from '@sdlc/contracts';

export const GIT_PROVIDERS = ['github', 'gitlab'] as const;
export type GitProvider = (typeof GIT_PROVIDERS)[number];

/** PostgreSQL enum type name → allowed values. Checked against the live schema by the tests. */
export const DB_ENUMS = {
  data_class: DATA_CLASSES,
  project_role: PROJECT_ROLES,
  git_provider: GIT_PROVIDERS,
  actor_type: ACTOR_TYPES,
  gate_code: GATE_CODES,
  risk_tier: RISK_TIERS,
  autonomy_level: AUTONOMY_LEVELS,
  change_flag: CHANGE_FLAGS,
  intent_status: INTENT_STATUSES,
  gate_decision: GATE_DECISIONS,
  gate_check_mode: GATE_CHECK_MODES,
  gate_reason_code: GATE_REASON_CODES,
  event_source: EVENT_SOURCES,
  run_status: RUN_STATUSES,
  escalation_trigger: ESCALATION_TRIGGERS,
  severity: SEVERITIES,
  response_level: RESPONSE_LEVELS,
  escalation_status: ESCALATION_STATUSES,
  escalation_route: ESCALATION_ROUTES,
  escalation_step: ESCALATION_STEPS,
} as const;

// Text columns with a CHECK constraint (D-05 section 6.1).
export const TENANT_STATUSES = ['active', 'suspended'] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

export const PROJECT_STATUSES = ['active', 'archived'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const USER_STATUSES = ['active', 'disabled'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

// Project AI record (handbook Chapter 2 section 2.5, template T7).
export const AI_ALLOWED_VALUES = ['no', 'yes', 'yes_with_conditions'] as const;
export type AiAllowed = (typeof AI_ALLOWED_VALUES)[number];

export const PROD_LOGS_ALLOWED_VALUES = ['no', 'yes_masked'] as const;
export type ProdLogsAllowed = (typeof PROD_LOGS_ALLOWED_VALUES)[number];

export const DISCLOSURE_FORMATS = ['client_format', 'standard_note'] as const;
export type DisclosureFormat = (typeof DISCLOSURE_FORMATS)[number];

// Registry (D-05 sections 6.2 and 6.3, B02).
export const SPEC_SOURCE_TOOLS = ['spec-kit', 'bmad', 'manual'] as const;
export type SpecSourceTool = (typeof SPEC_SOURCE_TOOLS)[number];

/** Where a gate decision came from (D-05 `gate_decisions.source`). */
export const GATE_DECISION_SOURCES = [
  'cli',
  'github_comment',
  'github_review',
  'workflow',
] as const;
export type GateDecisionSource = (typeof GATE_DECISION_SOURCES)[number];
