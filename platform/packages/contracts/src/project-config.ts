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
import type { EscalationRoute, ResponseLevel, SafeAction } from './escalation.js';

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

/** Who owns an escalation of one route (handbook Ch.6 §6.4 "Who receives it"). */
export interface EscalationRouting {
  readonly owner_role: ProjectRole;
  /** Null: no backup step; a missed acknowledgement goes straight to governance. */
  readonly backup_role: ProjectRole | null;
}

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
    /** Escalation raised when a gate passes `hitl_gate_deadline` (FR-12, FR-18; QUESTIONS #90). */
    readonly gate_overdue: {
      readonly severity: Severity;
      readonly response_level: ResponseLevel;
    };
  };
  readonly autonomy: { readonly max_by_risk: Readonly<Record<RiskTier, AutonomyLevel>> };
  readonly escalation: {
    readonly sla: Readonly<Record<Severity, SlaEntry>>;
    readonly calendar: WorkingCalendar;
    /** Owner and backup role per route (QUESTIONS #74). The last step is always governance. */
    readonly routing: Readonly<Record<EscalationRoute, EscalationRouting>>;
    /** Roles told when an escalation is raised, per severity (handbook Ch.6 §6.4 SLA "Notify"). */
    readonly notify_on_raise: Readonly<Record<Severity, readonly ProjectRole[]>>;
    /** Remind the step's holder when this share of the acknowledge window has passed (#75). */
    readonly reminder_percent: number;
    /** Actions that continue while the intent is frozen (handbook Ch.6 §6.5, QUESTIONS #76). */
    readonly safe_actions: readonly SafeAction[];
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
    /** Iteration cap of a run when the task sets none (FR-32, template T13; QUESTIONS.md #13). */
    readonly default_max_iterations: number;
    /** Time cap of a run in minutes when the task sets none (FR-32, template T13; QUESTIONS.md #13). */
    readonly default_max_duration_minutes: number;
    /**
     * The registered agent (its `agent_key`) that runs this project's intents (task C06,
     * QUESTIONS #108). Null: no agent; G4 fails with `agent_not_runnable` until one is set.
     */
    readonly agent_key: string | null;
    /**
     * Run Contracts issued for one G4 decision when each expires before a runner takes it (task
     * C06 session 2, ADR-M33 §2.6). Then the platform stops trying and escalates.
     */
    readonly contract_attempts_max: number;
    /**
     * The escalation raised when a run fails or is lost (ADR-M33 §2.7, D-03 §6 "Stopped →
     * Escalated"). Mandatory rule M20: the response level freezes the intent (`pause` or higher).
     */
    readonly failed_run_escalation: {
      readonly severity: Severity;
      readonly response_level: ResponseLevel;
    };
    /**
     * The escalation of a G5 breach (task C07, ADR-M34 §2.8): instruction files changed (route
     * `security`), the cost cap, the iteration or time cap, or a stalled run (route `intent`).
     * Mandatory rule M22: the response level freezes the intent (`pause` or higher; QUESTIONS #21).
     */
    readonly g5_breach_escalation: {
      readonly severity: Severity;
      readonly response_level: ResponseLevel;
    };
    /**
     * The escalation a kill raises at once (task C11, ADR-M42, QUESTIONS #181): route `technical`.
     * Mandatory rule M26: the response level freezes the intent (`pause` or higher).
     */
    readonly kill_escalation: {
      readonly severity: Severity;
      readonly response_level: ResponseLevel;
    };
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
  /** What G6 reads from CI (task C08 PR 2, QUESTIONS #159, ADR-M38 §2.7). */
  readonly verification: {
    /** Check names G6 waits for; empty: every check on the pushed commit. */
    readonly required_checks: readonly string[];
    /** Pending this long after the push → paused at G6, `technical` escalation. */
    readonly ci_timeout_minutes: number;
  };
  /**
   * Who may create and read intents through the API (task B03, ADR-M26, QUESTIONS.md #66).
   * Creators may always read. The viewer role never creates (mandatory rule M16).
   */
  readonly access: {
    readonly intent_create_roles: readonly ProjectRole[];
    readonly intent_read_roles: readonly ProjectRole[];
    /**
     * Who may create and update the project AI record (task B12, ADR-M32; D-02 §3, handbook Ch.2
     * §2.3 and §2.5, template T7). The viewer role never writes it (mandatory rule M19).
     */
    readonly ai_record_write_roles: readonly ProjectRole[];
    /** Who may read the project AI record. Writers may always read. */
    readonly ai_record_read_roles: readonly ProjectRole[];
    /**
     * Who may link an intent's spec (task B08, ADR-M39, QUESTIONS #162; D-02 FR-02). The viewer
     * role never links a spec (mandatory rule M23).
     */
    readonly spec_link_roles: readonly ProjectRole[];
    /**
     * Who may submit an intent's plan file (task B09, ADR-M40, QUESTIONS #168; D-08 B09). The
     * submitter is a producer of the plan and never approves G3 (FR-11). The viewer role never
     * submits a plan (mandatory rule M24).
     */
    readonly plan_submit_roles: readonly ProjectRole[];
    /**
     * Who may stop a run with the kill switch (task C11, ADR-M42, QUESTIONS #180; D-02 FR-34).
     * Person A, Person B and governance always may; the viewer never (mandatory rule M25).
     */
    readonly kill_roles: readonly ProjectRole[];
    /**
     * Who may read the cost report of the project or of one of its intents (task E04, ADR-M45,
     * QUESTIONS #196; D-02 FR-53). Tenant admins always may. The viewer never (mandatory rule M28).
     */
    readonly cost_read_roles: readonly ProjectRole[];
    /**
     * Who may read the gate waiting-time metrics of the project (task E06, ADR-M47, QUESTIONS
     * #206; D-02 FR-12). Tenant admins always may. The viewer never (mandatory rule M29).
     */
    readonly metrics_read_roles: readonly ProjectRole[];
    /**
     * Pairs of roles one person may not hold together on the project (task B13, ADR-M37,
     * QUESTIONS #154): a grant that would give someone both roles of a pair is refused. Person A
     * and Person B always stay apart (mandatory rule M21).
     */
    readonly conflicting_roles: readonly (readonly ProjectRole[])[];
  };
  /** Agent register (task C10, ADR-M31). */
  readonly agents: {
    /**
     * Maximum age of an agent's last recertification before the owner is warned (handbook Ch.20
     * §20.8: every 3 months; mandatory rule M18: never more than 3).
     */
    readonly recertification_months: number;
  };
  /** Sandbox image of the project, pinned by digest (QUESTIONS #59, ADR-M25). */
  readonly sandbox: { readonly image: string };
}

declare const validatedConfig: unique symbol;

/**
 * A configuration that passed the schema and the mandatory rules M1–M18. Only `@sdlc/config`
 * produces it (`loadProjectConfig`, `defaultProjectConfig`). Adapters accept this type, so they
 * never see an unchecked configuration and never repeat the checks (ADR-M16 §2.5, ADR-M18 §2.2).
 */
export type ValidatedProjectConfig = ProjectConfig & { readonly [validatedConfig]: true };
