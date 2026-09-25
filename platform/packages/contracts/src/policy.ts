// Policy engine interface (design/D-03 section 7.3, D-08 B01). The MVP implementation is
// `@sdlc/adapter-policy-simple`, which reads every rule value from the validated project
// configuration. OPA or Cedar can replace it later behind the same interface (ADR-M06).

import type {
  ActorType,
  AutonomyLevel,
  ChangeFlag,
  DataClass,
  GateCode,
  OversightMode,
  ProjectRole,
  ProviderType,
  RiskTier,
  Severity,
} from './codes.js';
import type { GateCheckMode } from './project-config.js';

/** Platform user id (`users.id`, design/D-05 section 6.1). */
export type UserId = string;

/** Kind of task for model routing by difficulty (design/D-07 section 4). Not used in the MVP. */
export type TaskKind = 'simple' | 'medium' | 'hard';

/** G8 uses a different matrix table for production and non-production releases. */
export type ReleaseEnvironment = 'production' | 'non_production';

/** Facts about the gate that change the oversight mode (design/D-03 section 6.1). */
export interface GateContext {
  /** G8 only. Missing means `production`, the stricter table. */
  readonly environment?: ReleaseEnvironment;
  /** G6 only: number of security findings per severity. Findings without a severity: leave out. */
  readonly securityFindings?: Readonly<Partial<Record<Severity, number>>>;
  /** G5 only: a limit (file scope, budget, loop) was breached. */
  readonly breached?: boolean;
}

/** Why the resolved oversight differs from the plain matrix cell (for the gate decision record). */
export type OversightOverride =
  'forced_hitl_change_flag' | 'security_finding' | 'limit_breached' | 'dual_approval_change_flag';

export interface OversightResolution {
  readonly mode: GateCheckMode;
  /** Approvals from different people. 0 unless `mode` is HITL. */
  readonly approvalsNeeded: number;
  /**
   * HITL: roles that may approve; when `approvalsNeeded` equals the number of roles, one approval
   * per role. HOTL / AUDIT: roles notified or sampling. POLICY: empty.
   */
  readonly roles: readonly ProjectRole[];
  readonly overrides: readonly OversightOverride[];
}

export interface OversightInput {
  readonly gate: GateCode;
  readonly riskTier: RiskTier;
  /** Change flags of the plan approved at G3 (design/D-05 `plans.change_flags`). */
  readonly changeFlags: readonly ChangeFlag[];
  readonly context?: GateContext;
}

/** One of the actor's role bindings on the intent's project (design/D-05 `role_bindings`). */
export interface RoleBindingRef {
  readonly role: ProjectRole;
  /** Revoked bindings never count (design/QUESTIONS.md #11). */
  readonly revokedAt: Date | null;
}

export interface IntentSummary {
  readonly riskTier: RiskTier;
  readonly changeFlags: readonly ChangeFlag[];
}

/** An approval already recorded for the same gate and bound input. */
export interface PriorApproval {
  readonly userId: UserId;
  readonly role: ProjectRole;
}

export interface ApproverInput {
  readonly gate: GateCode;
  readonly actor: { readonly id: UserId; readonly type: ActorType };
  /** The actor's role bindings on the intent's project, revoked ones included or not. */
  readonly roles: readonly RoleBindingRef[];
  readonly intent: IntentSummary;
  readonly context?: GateContext;
  /**
   * Producers of the change under review: commit authors, the person who started the run, and any
   * other person the caller counts for this gate (for example the intent creator at G7). They never
   * approve (design/D-03 section 6.2, QUESTIONS.md #16).
   */
  readonly producers: readonly UserId[];
  readonly priorApprovals?: readonly PriorApproval[];
}

export type ApprovalRefusal =
  /** Agents and the system never approve (D-02 FR-11). */
  | 'actor_not_human'
  /** The actor produced the change (D-02 FR-11). */
  | 'producer'
  /** The gate is an automatic policy check (POLICY) or sampled afterwards (AUDIT): nobody approves it. */
  | 'no_human_decision'
  /** The actor holds none of the gate's roles (active bindings only). */
  | 'role_missing'
  /** The actor already approved: dual approval needs two different people. */
  | 'already_approved'
  /** Every role the actor holds is already covered by another approver. */
  | 'role_already_covered'
  /** The gate already has all the approvals it needs. */
  | 'approvals_complete';

export type ApproveDecision =
  | { readonly allowed: true; readonly role: ProjectRole }
  | { readonly allowed: false; readonly reason: ApprovalRefusal };

export interface ScopeResult {
  readonly withinScope: boolean;
  /** Changed files that match no planned file or pattern, or are not safe relative paths. */
  readonly outOfScope: readonly string[];
}

/** A HITL decision that allows one grant-required action for one exact scope. */
export interface ActionGrant {
  readonly mode: OversightMode;
  readonly scope: string;
  readonly expiresAt: Date;
}

export interface AgentAction {
  /** A `FORBIDDEN_AGENT_ACTIONS` or `GRANT_REQUIRED_AGENT_ACTIONS` value, or any other action. */
  readonly kind: string;
  /** The resources the action touches, for example `db:orders` or `env:production`. */
  readonly scope?: string;
  readonly grant?: ActionGrant;
}

/** A model known to the gateway, with where it runs (design/D-07 section 4). */
export interface ModelRef {
  readonly model: string;
  readonly providerType: ProviderType;
}

export interface PolicyEngine {
  /** L0–L4 cap for an intent (D-02 FR-03). A data class with no allowed provider gives L0. */
  maxAutonomy(input: { riskTier: RiskTier; dataClass: DataClass }): AutonomyLevel;
  /** Resolved oversight for a gate (design/D-03 section 6.1). */
  oversightMode(input: OversightInput): OversightResolution;
  /** Models the data class may use (design/D-07 section 4). `taskKind` is not used in the MVP. */
  allowedModels(input: { dataClass: DataClass; taskKind?: TaskKind }): string[];
  /** Changed files against the plan's files and path patterns (G5). */
  checkScope(input: {
    plannedFiles: readonly string[];
    changedFiles: readonly string[];
  }): ScopeResult;
  /** Who may approve (design/D-03 section 6.2, D-02 FR-11, FR-16). */
  canApprove(input: ApproverInput): ApproveDecision;
  /** Handbook Ch.4 §4.7. Never overridable by configuration. */
  isForbidden(input: { action: AgentAction; now?: Date }): boolean;
}
