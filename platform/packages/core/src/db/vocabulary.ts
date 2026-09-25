// Vocabularies stored as PostgreSQL enums and CHECK constraints (design/D-05 section 5).
// Canonical codes (data classes, 2+N roles, …) come from `@sdlc/contracts`; this file lists only
// the values that exist in the database layer alone. Only the enums used by the tables of task A06
// exist yet; later tasks add theirs with their tables.
// Changing a list needs a migration: design/ADR-M09-database-tooling.md section 2.5.
import { DATA_CLASSES, PROJECT_ROLES } from '@sdlc/contracts';

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
