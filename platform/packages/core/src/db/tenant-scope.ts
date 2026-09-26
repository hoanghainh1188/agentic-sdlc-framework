// The only way to reach tenant data (design/D-05 D1, D-08 A06 AC3).
import type { Kysely } from 'kysely';

import type { Database } from './schema.js';
import { TenantGuardPlugin } from './tenant-guard-plugin.js';
import { parseTenantId, type TenantId } from './tenant-id.js';
import { ApiTokenRepository } from './repositories/api-tokens.js';
import { AuditLogRepository } from './repositories/audit-log.js';
import { CostRecordRepository } from './repositories/cost-records.js';
import { GateDecisionRepository } from './repositories/gate-decisions.js';
import { GitEventCursorRepository } from './repositories/git-event-cursors.js';
import { IntentRepository } from './repositories/intents.js';
import { PlanRepository } from './repositories/plans.js';
import { ProjectAiRecordRepository } from './repositories/project-ai-records.js';
import { ProjectConfigRepository } from './repositories/project-configs.js';
import { ProjectRepository } from './repositories/projects.js';
import { RoleBindingRepository } from './repositories/role-bindings.js';
import { RunContractRepository } from './repositories/run-contracts.js';
import { RunEventRepository } from './repositories/run-events.js';
import { RunRepository } from './repositories/runs.js';
import { SpecRefRepository } from './repositories/spec-refs.js';
import { UserIdentityRepository } from './repositories/user-identities.js';
import { UserRepository } from './repositories/users.js';

/**
 * Repositories bound to one tenant. Every query they send passes the tenant guard, which
 * rejects any table access without `tenant_id = <this tenant>`.
 */
export class TenantScope {
  readonly tenantId: TenantId;
  readonly projects: ProjectRepository;
  readonly projectConfigs: ProjectConfigRepository;
  readonly projectAiRecords: ProjectAiRecordRepository;
  readonly users: UserRepository;
  readonly userIdentities: UserIdentityRepository;
  readonly roleBindings: RoleBindingRepository;
  readonly apiTokens: ApiTokenRepository;
  readonly gitEventCursors: GitEventCursorRepository;
  readonly audit: AuditLogRepository;
  readonly intents: IntentRepository;
  readonly specRefs: SpecRefRepository;
  readonly plans: PlanRepository;
  readonly gateDecisions: GateDecisionRepository;
  readonly runs: RunRepository;
  readonly runContracts: RunContractRepository;
  readonly runEvents: RunEventRepository;
  readonly costRecords: CostRecordRepository;

  private readonly db: Kysely<Database>;

  /** @internal Use `PlatformDatabase.forTenant`. */
  constructor(db: Kysely<Database>, tenantId: TenantId) {
    // Checked again at runtime: the brand can be forged with a type assertion.
    this.tenantId = parseTenantId(tenantId);
    this.db = db.withPlugin(new TenantGuardPlugin(this.tenantId));
    this.projects = new ProjectRepository(this.db, this.tenantId);
    this.projectConfigs = new ProjectConfigRepository(this.db, this.tenantId);
    this.projectAiRecords = new ProjectAiRecordRepository(this.db, this.tenantId);
    this.users = new UserRepository(this.db, this.tenantId);
    this.userIdentities = new UserIdentityRepository(this.db, this.tenantId);
    this.roleBindings = new RoleBindingRepository(this.db, this.tenantId);
    this.apiTokens = new ApiTokenRepository(this.db, this.tenantId);
    this.gitEventCursors = new GitEventCursorRepository(this.db, this.tenantId);
    this.audit = new AuditLogRepository(this.db, this.tenantId);
    this.intents = new IntentRepository(this.db, this.tenantId);
    this.specRefs = new SpecRefRepository(this.db, this.tenantId);
    this.plans = new PlanRepository(this.db, this.tenantId);
    this.gateDecisions = new GateDecisionRepository(this.db, this.tenantId);
    this.runs = new RunRepository(this.db, this.tenantId);
    this.runContracts = new RunContractRepository(this.db, this.tenantId);
    this.runEvents = new RunEventRepository(this.db, this.tenantId);
    this.costRecords = new CostRecordRepository(this.db, this.tenantId);
  }

  /** Runs `work` in one database transaction, with repositories bound to the same tenant. */
  transaction<T>(work: (scope: TenantScope) => Promise<T>): Promise<T> {
    return this.db.transaction().execute((trx) => work(new TenantScope(trx, this.tenantId)));
  }
}
