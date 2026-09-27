// Shape of the project configuration (design/D-05 section 6.1 `project_configs`, D-08 A05).
// `@sdlc/config` parses, validates and hashes it; policy and workflow code only read it.
// Keys are snake_case, exactly as written in the YAML file.

import type {
  AutonomyLevel,
  ChangeFlag,
  DataClass,
  OversightMode,
  ProjectRole,
  ProviderType,
  RiskTier,
  Severity,
} from './codes.js';

/**
 * How a gate is checked for one risk tier. `POLICY` = automatic policy check with no human
 * decision; allowed at G4 only (codes table §4 "Policy check", design/QUESTIONS.md #6).
 */
export type GateCheckMode = OversightMode | 'POLICY';

export interface OversightCell {
  readonly mode: GateCheckMode;
  /** HITL: roles that may approve. HOTL / AUDIT: roles notified or sampling. POLICY: empty. */
  readonly roles: readonly ProjectRole[];
  /** Approvals needed from different people, one per listed role when more than one (HITL). */
  readonly approvals: number;
  /** The mode used once a limit is breached; must be HITL (codes table §4, G5 High). */
  readonly on_breach?: OversightMode;
}

export type TierMatrix = Readonly<Record<RiskTier, OversightCell>>;

export interface OversightMatrix {
  readonly G1: TierMatrix;
  readonly G2: TierMatrix;
  readonly G3: TierMatrix;
  readonly G4: TierMatrix;
  readonly G5: TierMatrix;
  readonly G6: TierMatrix;
  readonly G7: TierMatrix;
  readonly G8: { readonly production: TierMatrix; readonly non_production: TierMatrix };
}

/** Wall-clock units run all the time; working units follow the working calendar. */
export type DurationUnit = 'minutes' | 'hours' | 'days' | 'working_hours' | 'working_days';

export interface Duration {
  readonly value: number;
  readonly unit: DurationUnit;
}

/** A resolution deadline: a duration, the end of the working day, or no clock ("next planned work"). */
export type Deadline =
  Duration | { readonly kind: 'end_of_working_day' } | { readonly kind: 'next_planned_work' };

export interface SlaEntry {
  readonly acknowledge: Duration;
  readonly resolve: Deadline;
}

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export interface WorkingCalendar {
  /** IANA time zone, for example `Asia/Ho_Chi_Minh`. */
  readonly time_zone: string;
  readonly working_days: readonly Weekday[];
  /** Local times `HH:MM`, start before end. */
  readonly working_hours: { readonly start: string; readonly end: string };
  /** Local dates `YYYY-MM-DD` that are not working days (for example Tết). */
  readonly holidays: readonly string[];
}

/**
 * Security findings at G6 (codes table §4 row G6, design/QUESTIONS.md #19). Findings at or above
 * `min_severity` make G6 use `mode`; findings below it are recorded as evidence only. A critical
 * finding is always at or above the threshold (rule M6 in `@sdlc/config`).
 */
export interface SecurityFindingsPolicy {
  readonly mode: OversightMode;
  readonly min_severity: Severity;
}

export interface ProjectConfig {
  readonly schema_version: 1;
  readonly oversight: {
    readonly matrix: OversightMatrix;
    readonly forced_hitl_g3: { readonly change_flags: readonly ChangeFlag[] };
    readonly dual_approval_g7: {
      readonly change_flags: readonly ChangeFlag[];
      readonly roles: readonly ProjectRole[];
    };
    readonly g6_security_findings: SecurityFindingsPolicy;
    readonly hitl_gate_deadline: Duration;
    readonly hotl_block_window: Duration;
    readonly approval_expiry: Duration;
  };
  readonly autonomy: { readonly max_by_risk: Readonly<Record<RiskTier, AutonomyLevel>> };
  readonly escalation: {
    readonly sla: Readonly<Record<Severity, SlaEntry>>;
    readonly calendar: WorkingCalendar;
  };
  readonly run: {
    readonly g6_ci_retries: number;
    readonly loop_detection: {
      readonly identical_tool_calls_max: number;
      readonly no_progress_window_minutes: number;
    };
    /** Run Contract validity, from issue to sandbox start (QUESTIONS.md #33, ADR-M22). */
    readonly contract_validity_minutes: number;
    /** Tolerated clock difference for the "not yet valid" check only; expiry has none (ADR-M22). */
    readonly contract_clock_skew_seconds: number;
  };
  readonly budget: {
    readonly warn_percent: number;
    readonly stop_percent: number;
    readonly default_intent_usd: number;
    readonly default_run_usd: number;
  };
  readonly model_routing: {
    readonly allowed_provider_types: Readonly<Record<DataClass, readonly ProviderType[]>>;
  };
  readonly retention: { readonly evidence_retention_days: number };
  readonly github: { readonly poll_interval_seconds: number };
  /**
   * Who may create and read intents through the API (task B03, ADR-M26, QUESTIONS.md #66).
   * Creators may always read. The viewer role never creates (mandatory rule M16).
   */
  readonly access: {
    readonly intent_create_roles: readonly ProjectRole[];
    readonly intent_read_roles: readonly ProjectRole[];
  };
}

declare const validatedConfig: unique symbol;

/**
 * A configuration that passed the schema and the mandatory rules M1–M16. Only `@sdlc/config`
 * produces it (`loadProjectConfig`, `defaultProjectConfig`). Adapters accept this type, so they
 * never see an unchecked configuration and never repeat the checks (ADR-M16 §2.5, ADR-M18 §2.2).
 */
export type ValidatedProjectConfig = ProjectConfig & { readonly [validatedConfig]: true };
