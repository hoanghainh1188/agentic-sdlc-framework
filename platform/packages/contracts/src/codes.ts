// Canonical codes shared by every package (handbook/00-introduction/05-codes.md, design/D-05 section 5).
// Each list is the single source of the matching union type. Keep the order of the source tables.

export const GATE_CODES = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8'] as const;
export type GateCode = (typeof GATE_CODES)[number];

export const PHASE_CODES = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'] as const;
export type PhaseCode = (typeof PHASE_CODES)[number];

/** Codes table §2.1. The MVP allows L0–L2 only (design/D-02 section 4.2). */
export const AUTONOMY_LEVELS = ['L0', 'L1', 'L2', 'L3', 'L4'] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

/** Codes table §2.2. */
export const OVERSIGHT_MODES = ['HITL', 'HOTL', 'AUDIT'] as const;
export type OversightMode = (typeof OVERSIGHT_MODES)[number];

/** Codes table §3. */
export const RISK_TIERS = ['low', 'medium', 'high', 'critical'] as const;
export type RiskTier = (typeof RISK_TIERS)[number];

export const DATA_CLASSES = [
  'public',
  'internal',
  'client_confidential',
  'client_restricted',
  'prohibited',
] as const;
export type DataClass = (typeof DATA_CLASSES)[number];

/** Codes table §5 (2+N), design/D-05 section 5. */
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

/**
 * Change flags set on a plan at G3 (design/D-05 section 5). Some force HITL at G3, some need dual
 * approval at G7; the lists themselves live in the project configuration.
 */
export const CHANGE_FLAGS = [
  'migration',
  'breaking_contract',
  'new_service_boundary',
  'security_boundary',
  'system_of_record',
  'prod_infrastructure',
  'core_business_rule',
  'payment',
  'personal_data',
  'safety_function',
] as const;
export type ChangeFlag = (typeof CHANGE_FLAGS)[number];

/** Codes table §6.3. */
export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Where a model runs (design/D-05 `cost_records.provider_type`, design/D-07 section 4). */
export const PROVIDER_TYPES = ['api', 'self_hosted'] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

/** Who performed an action (design/D-05 `actor_type`): audit log, gate decisions, plans. */
export const ACTOR_TYPES = ['human', 'system', 'agent'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

/** Lifecycle status of an intent (design/D-05 section 5 `intent_status`). */
export const INTENT_STATUSES = [
  'draft',
  'in_gate',
  'running',
  'paused',
  'blocked',
  'done',
  'rejected',
  'cancelled',
] as const;
export type IntentStatus = (typeof INTENT_STATUSES)[number];

/** Status of an agent run (design/D-05 section 5 `run_status`). */
export const RUN_STATUSES = [
  'queued',
  'provisioning',
  'running',
  'stopping',
  'succeeded',
  'succeeded_proposal_only',
  'failed',
  'stopped_budget',
  'stopped_scope',
  'stopped_timeout',
  'stopped_stalled',
  'stopped_killed',
  'cancelled',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** Final run statuses: once a run has one, the database refuses any change to it (ADR-M22). */
export const FINAL_RUN_STATUSES = [
  'succeeded',
  'succeeded_proposal_only',
  'failed',
  'stopped_budget',
  'stopped_scope',
  'stopped_timeout',
  'stopped_stalled',
  'stopped_killed',
  'cancelled',
] as const satisfies readonly RunStatus[];

/**
 * A decision at a gate (design/D-05 section 5 `gate_decision`). Humans record `approve`, `reject`,
 * `request_changes`, `pause` and `block`; the system records `pass`, `fail`, `block`, `pause` and
 * `void` (an earlier approval became invalid: expired or mismatched).
 */
export const GATE_DECISIONS = [
  'approve',
  'reject',
  'request_changes',
  'pause',
  'block',
  'pass',
  'fail',
  'void',
] as const;
export type GateDecision = (typeof GATE_DECISIONS)[number];

/**
 * How a gate was checked, as stored in a gate decision: an oversight mode, or `POLICY` for the
 * automatic policy check at G4 (design/QUESTIONS.md #6, ADR-M20). Same values as `GateCheckMode`.
 */
export const GATE_CHECK_MODES = ['HITL', 'HOTL', 'AUDIT', 'POLICY'] as const;

/**
 * Why a gate decision was not a plain approval or pass (design/ADR-M20). Gate decisions are kept
 * at least 2 years and never change, so they hold a code, never free text; the human explanation
 * stays on the Git host (`reason_ref`), where it can be edited or deleted.
 */
export const GATE_REASON_CODES = [
  'spec_unclear',
  'tests_insufficient',
  'security_finding',
  'out_of_scope',
  'policy_denied',
  'budget_exceeded',
  'ci_failed',
  'ai_record_missing',
  'data_class_not_allowed',
  'expired',
  'input_mismatch',
  'scope_mismatch',
  'other',
] as const;
export type GateReasonCode = (typeof GATE_REASON_CODES)[number];

/** How a Git host event reached the platform (design/D-05 section 5, ADR-M11). */
export const EVENT_SOURCES = ['polling', 'webhook'] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];
