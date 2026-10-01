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
export {
  SystemScope,
  type NewTenant,
  type DueEscalation,
  type OpenIntent,
  type PollableProject,
  type ResolvedApiToken,
} from './system-scope.js';
export { isUuid, parseTenantId, type TenantId } from './tenant-id.js';
export { hashApiToken } from './repositories/api-tokens.js';
export type { AgentQuery, AgentUpdate, NewAgent } from './repositories/agents.js';
export type { AuditEvent } from './repositories/audit-log.js';
export type { NewCostRecord } from './repositories/cost-records.js';
export type { NewEvidenceItem } from './repositories/evidence-items.js';
export type {
  EscalationClockUpdate,
  EscalationQuery,
  NewEscalation,
  NewEscalationNotice,
} from './repositories/escalations.js';
export type {
  DecideInput,
  HumanDecisionInput,
  RevalidateInput,
  RevalidateResult,
  SystemDecisionInput,
} from './repositories/gate-decisions.js';
export {
  MAX_INTENT_PAGE,
  type IntentMove,
  type IntentPageQuery,
  type IntentPosition,
  type IntentQuery,
  type IntentStateChange,
  type NewIntent,
} from './repositories/intents.js';
export type { NewIntentNotice } from './repositories/intent-notices.js';
export type { SubmitPlan } from './repositories/plans.js';
export type { RegistryActor } from './repositories/registry-actor.js';
export type { StoreRunContract, StoredRunContract } from './repositories/run-contracts.js';
export { isSafeRepoPath, type LinkSpec } from './repositories/spec-refs.js';
export type { SaveProjectConfig } from './repositories/project-configs.js';
export type { RoleBindingQuery } from './repositories/role-bindings.js';
export type { SaveProjectAiRecord } from './repositories/project-ai-records.js';
export type {
  Agent,
  ApiToken,
  AuditLogRow,
  CostRecordRow,
  Escalation,
  EvidenceItem,
  EscalationNotice,
  GateDecisionRow,
  GitEventCursor,
  Intent,
  IntentNotice,
  Plan,
  Project,
  ProjectAiRecord,
  ProjectAiRecordVersion,
  ProjectConfig,
  RoleBinding,
  Run,
  RunContractRow,
  RunEventRow,
  SpecRef,
  Tenant,
  TenantInsert,
  User,
  UserIdentity,
} from './schema.js';
export * from './vocabulary.js';
