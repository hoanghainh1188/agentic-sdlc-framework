// Data access layer (design/D-05, design/ADR-M09-database-tooling.md).
export type { DatabaseConfig } from './connection.js';
export {
  DbError,
  TenantGuardError,
  type DbErrorCode,
  type TenantGuardErrorCode,
} from './errors.js';
export { PlatformDatabase } from './platform-database.js';
export { TenantScope } from './tenant-scope.js';
export { SystemScope, type NewTenant, type ResolvedApiToken } from './system-scope.js';
export { isUuid, parseTenantId, type TenantId } from './tenant-id.js';
export { hashApiToken } from './repositories/api-tokens.js';
export type { SaveProjectConfig } from './repositories/project-configs.js';
export type { SaveProjectAiRecord } from './repositories/project-ai-records.js';
export type {
  ApiToken,
  GitEventCursor,
  Project,
  ProjectAiRecord,
  ProjectConfig,
  RoleBinding,
  Tenant,
  TenantInsert,
  User,
  UserIdentity,
} from './schema.js';
export * from './vocabulary.js';
