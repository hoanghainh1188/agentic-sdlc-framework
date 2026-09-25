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
