// Canonical vocabularies stored as PostgreSQL enums (design/D-05 section 5, handbook codes table).
// Only the enums used by the tables of task A06 exist yet; later tasks add theirs with their tables.
// Changing a list here needs a migration: design/ADR-M09-database-tooling.md section 2.5.

export const DATA_CLASSES = [
  'public',
  'internal',
  'client_confidential',
  'client_restricted',
  'prohibited',
] as const;
export type DataClass = (typeof DATA_CLASSES)[number];

// The 2+N roles (handbook Chapter 5). Which role may approve which gate is policy config (A05, B01).
export const PROJECT_ROLES = [
  'person_a',
  'person_b',
  'second_approver',
  'pm_brse',
  'governance',
  'admin',
  'viewer',
] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

export const GIT_PROVIDERS = ['github', 'gitlab'] as const;
export type GitProvider = (typeof GIT_PROVIDERS)[number];

/** PostgreSQL enum type name → allowed values. Checked against the live schema by the tests. */
export const DB_ENUMS = {
  data_class: DATA_CLASSES,
  project_role: PROJECT_ROLES,
  git_provider: GIT_PROVIDERS,
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
