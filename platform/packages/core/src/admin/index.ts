// Operator commands run on the server: tenant bootstrap and API tokens (task B03, ADR-M26),
// and the admin services of task B13 (below).
export {
  bootstrapTenant,
  TENANT_SLUG_PATTERN,
  type BootstrapInput,
  type BootstrapResult,
} from './bootstrap.js';
export {
  API_TOKEN_DEFAULT_LIFETIME_DAYS,
  API_TOKEN_MAX_LIFETIME_DAYS,
  API_TOKEN_NAME_PATTERN,
  API_TOKEN_PATTERN,
  API_TOKEN_PREFIX,
  generateApiToken,
  isApiTokenFormat,
  issueApiToken,
  revokeApiToken,
  type IssueApiToken,
  type IssuedApiToken,
} from './tokens.js';
// Admin onboarding (task B13, ADR-M37): tenant admins, projects, users, identities, project roles
// and configuration. The API calls these as a person; operator commands call them as `system`.
export {
  assertTenantAdmin,
  auditActor,
  isTenantAdmin,
  projectAdminAccess,
  projectAdminWrite,
  SYSTEM_ACTOR,
  type AdminActor,
  type ProjectAdminAccess,
} from './actor.js';
export {
  checkStoredConfigsAtStart,
  MAX_CONFIG_YAML_BYTES,
  reconcileStoredConfigs,
  saveProjectConfig,
  showProjectConfig,
  warningCodes,
  type ProjectConfigView,
  type ReconcileOutcome,
  type ReconcileResult,
  type SaveConfigInput,
} from './config.js';
export { verifyTenantAudit } from './audit-check.js';
export { AdminError, type AdminErrorCode } from './errors.js';
export {
  issueTokenFor,
  listTokensOf,
  revokeTokenOf,
  TOKEN_FOR_OTHER_MAX_DAYS,
  type IssuedTokenView,
  type IssueTokenRequest,
} from './token-access.js';
export {
  activeProject,
  archiveProject,
  createProject,
  listProjects,
  showProject,
  SUPPORTED_GIT_PROVIDERS,
  updateProject,
  type NewProject,
  type ProjectChanges,
} from './projects.js';
export {
  conflictingRole,
  grantProjectRole,
  listProjectRoles,
  revokeProjectRole,
  type GrantProjectRole,
} from './roles.js';
export {
  assertAdminRemains,
  grantTenantRole,
  listTenantRoles,
  revokeTenantRole,
  type GrantTenantRole,
} from './tenant-roles.js';
export {
  createUser,
  findUser,
  linkIdentity,
  listIdentities,
  listUsers,
  setUserActive,
  showUser,
  unlinkIdentity,
  updateUser,
  type LinkIdentity,
} from './users.js';
export {
  BRANCH_PATTERN,
  EMAIL_PATTERN,
  EXTERNAL_ID_PATTERN,
  EXTERNAL_LOGIN_PATTERN,
  MAX_EMAIL_LENGTH,
  MAX_NAME_LENGTH,
  PROJECT_SLUG_PATTERN,
  REPO_FULL_NAME_PATTERN,
} from './validation.js';
