// Mandatory rules: the floors that no project configuration may loosen (design/D-08 A05 AC2,
// ADR-M18). They live in code on purpose, so that configuration cannot change them. Changing a
// floor needs an approved handbook change, then the design doc, then a backlog task (CLAUDE.md).
//
// Rule ids M1–M23 and their sources:
//   M1  G1 HITL at every tier ........................................ codes table §4 row G1
//   M2  G7 HITL at every tier, Person B; Critical needs 2 approvers .. codes table §4 row G7
//   M3  G8 production HITL, Person B; Critical needs 2 approvers ..... codes table §4 row G8, D-02 §4.2
//   M4  forced-HITL G3 flags contain the handbook list ............... codes table §4, D-02 FR-15
//   M5  dual-approval G7 flags and roles contain the handbook list ... codes table §4, D-02 FR-16
//   M6  G6 security findings HITL; critical always counts ........... codes table §4 row G6, Ch.14 §14.8,
//                                                                     design/QUESTIONS.md #19
//   M7  autonomy ≤ L2, Critical L0, High ≤ L1, ordered by risk ....... D-02 FR-03 and §4.2
//   M8  client_restricted self-hosted only, prohibited none .......... D-07 §4
//   M9  budget warn ≤ 80 %, stop ≤ 100 %, warn < stop ................ D-07 §6, Ch.3 §3.6
//   M10 loop limit ≤ 3 identical tool calls .......................... D-02 FR-35, Ch.3 §3.6
//   M11 SLA clocks never longer than the handbook; calendar floor .... codes table §6.3, Ch.6 §6.4
//       (≥ 5 working days per week, ≥ 7 working hours per day)
//   M12 cell structure (POLICY at G4 only, roles, approvals) ......... codes table §4, D-05 §5
//   M13 human approval of high-risk effects (High/Critical HITL) ..... codes table §4 "never skipped"
//   M14 permission before dangerous actions (G4 High/Critical HITL) .. codes table §4, Ch.13 §13.8
//   M15 independent verification (G6 never POLICY) ................... codes table §4 "never skipped"
//   M16 the viewer role never creates intents ........................ D-05 §5, QUESTIONS.md #66
//   M17 escalation routing: policy → governance, no viewer, backup ≠ . Ch.6 §6.4, codes table §6.3,
//       owner; notify lists contain the handbook's roles ............ QUESTIONS.md #74
//   M18 agent recertification at least every 3 months ............... Ch.20 §20.8, ADR-M31
//   M19 the viewer role never writes the project AI record ........... ADR-M32, QUESTIONS.md #103
//   M20 a failed or lost run freezes the intent (pause or higher) .... D-03 §6, ADR-M33 §2.7
//   M21 Person A and Person B are never the same person on a project . codes table §5, ADR-M37,
//                                                                      QUESTIONS #154
//   M22 a G5 breach freezes the intent (pause or higher) ............. QUESTIONS.md #21, ADR-M34 §2.8
//   M23 the viewer role never links a spec ........................... ADR-M39, QUESTIONS.md #162
import type {
  AutonomyLevel,
  EscalationRoute,
  ChangeFlag,
  Deadline,
  GateCheckMode,
  OversightCell,
  ProjectConfig,
  ProjectRole,
  ResponseLevel,
  RiskTier,
  Severity,
  SlaEntry,
  WorkingCalendar,
} from '@sdlc/contracts';
import { ESCALATION_ROUTES, RISK_TIERS, SEVERITIES } from '@sdlc/contracts';

import { durationMinutes, isWorkingUnit, workingDayMinutes } from './calendar.js';
import { issue, type ConfigIssue } from './issues.js';

export const MVP_MAX_AUTONOMY: AutonomyLevel = 'L2';

/** Handbook Ch.20 §20.8: every agent is recertified at least every 3 months (rule M18). */
export const MAX_RECERTIFICATION_MONTHS = 3;

export const FORCED_HITL_G3_FLAGS: readonly ChangeFlag[] = [
  'migration',
  'breaking_contract',
  'new_service_boundary',
  'security_boundary',
  'system_of_record',
  'prod_infrastructure',
  'core_business_rule',
];

export const DUAL_APPROVAL_G7_FLAGS: readonly ChangeFlag[] = [
  'migration',
  'payment',
  'personal_data',
  'prod_infrastructure',
  'breaking_contract',
  'safety_function',
];

export const DUAL_APPROVAL_ROLES: readonly ProjectRole[] = ['person_b', 'second_approver'];

export const MAX_WARN_PERCENT = 80;
export const MAX_STOP_PERCENT = 100;
export const MAX_IDENTICAL_TOOL_CALLS = 3;

/**
 * Calendar floor for M11. SLA clocks are compared in the project's own calendar, so a shrunken
 * calendar would stretch "1 working day" in real time (Harry, 2026-09-25, PR #53).
 */
export const MIN_WORKING_DAYS_PER_WEEK = 5;
export const MIN_WORKING_HOURS_PER_DAY = 7;

/** Longest allowed SLA clocks: acknowledge from codes table §6.3, resolve from Ch.6 §6.4. */
export const HANDBOOK_SLA: Readonly<Record<Severity, SlaEntry>> = {
  critical: { acknowledge: { value: 15, unit: 'minutes' }, resolve: { value: 1, unit: 'hours' } },
  high: { acknowledge: { value: 1, unit: 'hours' }, resolve: { kind: 'end_of_working_day' } },
  medium: {
    acknowledge: { value: 1, unit: 'working_days' },
    resolve: { value: 3, unit: 'working_days' },
  },
  low: { acknowledge: { value: 3, unit: 'working_days' }, resolve: { kind: 'next_planned_work' } },
};

/** Strictness of gate check modes: a lower number is looser. */
export const MODE_STRICTNESS: Readonly<Record<GateCheckMode, number>> = {
  POLICY: 0,
  AUDIT: 1,
  HOTL: 2,
  HITL: 3,
};

const AUTONOMY_RANK: Readonly<Record<AutonomyLevel, number>> = {
  L0: 0,
  L1: 1,
  L2: 2,
  L3: 3,
  L4: 4,
};
const HIGH_RISK: readonly RiskTier[] = ['high', 'critical'];

export interface CellRef {
  readonly gate: string;
  readonly tier: RiskTier;
  readonly path: string;
  readonly cell: OversightCell;
}

/** Every cell of the matrix. G8 appears as `G8.production` and `G8.non_production`. */
export function matrixCells(config: ProjectConfig): CellRef[] {
  const { matrix } = config.oversight;
  const tables = [
    ...(['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7'] as const).map((gate) => ({
      gate,
      table: matrix[gate],
    })),
    { gate: 'G8.production', table: matrix.G8.production },
    { gate: 'G8.non_production', table: matrix.G8.non_production },
  ];
  return tables.flatMap(({ gate, table }) =>
    RISK_TIERS.map((tier) => ({
      gate,
      tier,
      path: `oversight.matrix.${gate}.${tier}`,
      cell: table[tier],
    })),
  );
}

function cellsOf(
  config: ProjectConfig,
  gates: readonly string[],
  tiers: readonly RiskTier[] = RISK_TIERS,
): CellRef[] {
  return matrixCells(config).filter((ref) => gates.includes(ref.gate) && tiers.includes(ref.tier));
}

function requireHitl(refs: readonly CellRef[], key: Parameters<typeof issue>[0]): ConfigIssue[] {
  return refs
    .filter((ref) => ref.cell.mode !== 'HITL')
    .map((ref) =>
      issue(key, `${ref.path}.mode`, { gate: ref.gate, tier: ref.tier, found: ref.cell.mode }),
    );
}

function requirePersonB(refs: readonly CellRef[]): ConfigIssue[] {
  return refs
    .filter((ref) => !ref.cell.roles.includes('person_b'))
    .map((ref) => issue('config.rule.person_b_required', `${ref.path}.roles`, { gate: ref.gate }));
}

function requireDualApproval(refs: readonly CellRef[]): ConfigIssue[] {
  return refs
    .filter(
      (ref) =>
        ref.cell.approvals < 2 ||
        DUAL_APPROVAL_ROLES.some((role) => !ref.cell.roles.includes(role)),
    )
    .map((ref) => issue('config.rule.critical_dual_approval', ref.path, { gate: ref.gate }));
}

const m1: Rule = (c) => requireHitl(cellsOf(c, ['G1']), 'config.rule.g1_hitl');

const m2: Rule = (c) => [
  ...requireHitl(cellsOf(c, ['G7']), 'config.rule.g7_hitl'),
  ...requirePersonB(cellsOf(c, ['G7'])),
  ...requireDualApproval(cellsOf(c, ['G7'], ['critical'])),
];

const m3: Rule = (c) => [
  ...requireHitl(cellsOf(c, ['G8.production']), 'config.rule.g8_production_hitl'),
  ...requirePersonB(cellsOf(c, ['G8.production'])),
  ...requireDualApproval(cellsOf(c, ['G8.production', 'G8.non_production'], ['critical'])),
];

function missingItems<T>(required: readonly T[], actual: readonly T[]): T[] {
  return required.filter((item) => !actual.includes(item));
}

const m4: Rule = (c) =>
  missingItems(FORCED_HITL_G3_FLAGS, c.oversight.forced_hitl_g3.change_flags).map((flag) =>
    issue('config.rule.forced_hitl_flag_missing', 'oversight.forced_hitl_g3.change_flags', {
      flag,
    }),
  );

const m5: Rule = (c) => [
  ...missingItems(DUAL_APPROVAL_G7_FLAGS, c.oversight.dual_approval_g7.change_flags).map((flag) =>
    issue('config.rule.dual_approval_flag_missing', 'oversight.dual_approval_g7.change_flags', {
      flag,
    }),
  ),
  ...missingItems(DUAL_APPROVAL_ROLES, c.oversight.dual_approval_g7.roles).map((role) =>
    issue('config.rule.dual_approval_role_missing', 'oversight.dual_approval_g7.roles', { role }),
  ),
];

/**
 * A security finding of this severity always makes G6 HITL, whatever `min_severity` says (M6).
 * Escalation for a critical finding stays in the workflow (D-03 §6, task B07).
 */
export const ALWAYS_HITL_SECURITY_SEVERITY: Severity = 'critical';

/** True when `severity` is at or above `threshold` (`SEVERITIES` lists the most severe first). */
export function severityAtOrAbove(severity: Severity, threshold: Severity): boolean {
  const rank = SEVERITIES.indexOf(severity);
  return rank !== -1 && rank <= SEVERITIES.indexOf(threshold);
}

const m6: Rule = (c) => {
  const { mode, min_severity: minSeverity } = c.oversight.g6_security_findings;
  const path = 'oversight.g6_security_findings';
  return [
    ...(mode === 'HITL'
      ? []
      : [issue('config.rule.g6_security_hitl', `${path}.mode`, { found: mode })]),
    ...(severityAtOrAbove(ALWAYS_HITL_SECURITY_SEVERITY, minSeverity)
      ? []
      : [
          issue('config.rule.g6_security_critical', `${path}.min_severity`, {
            found: minSeverity,
            severity: ALWAYS_HITL_SECURITY_SEVERITY,
          }),
        ]),
  ];
};

const m7: Rule = (c) => {
  const levels = c.autonomy.max_by_risk;
  const path = (tier: RiskTier) => `autonomy.max_by_risk.${tier}`;
  const rank = (tier: RiskTier) => AUTONOMY_RANK[levels[tier]];
  const found: ConfigIssue[] = RISK_TIERS.filter(
    (tier) => rank(tier) > AUTONOMY_RANK[MVP_MAX_AUTONOMY],
  ).map((tier) =>
    issue('config.rule.autonomy_above_mvp', path(tier), {
      found: levels[tier],
      maximum: MVP_MAX_AUTONOMY,
    }),
  );
  if (levels.critical !== 'L0')
    found.push(
      issue('config.rule.autonomy_critical_l0', path('critical'), { found: levels.critical }),
    );
  if (rank('high') > AUTONOMY_RANK.L1)
    found.push(issue('config.rule.autonomy_high_l1', path('high'), { found: levels.high }));
  RISK_TIERS.slice(1).forEach((tier, index) => {
    const lower = RISK_TIERS[index] ?? 'low';
    if (rank(tier) > rank(lower))
      found.push(issue('config.rule.autonomy_order', path(tier), { tier, lower_tier: lower }));
  });
  return found;
};

const m8: Rule = (c) => {
  const routing = c.model_routing.allowed_provider_types;
  const base = 'model_routing.allowed_provider_types';
  return [
    ...(routing.client_restricted.includes('api')
      ? [issue('config.rule.routing_restricted_self_hosted', `${base}.client_restricted`)]
      : []),
    ...(routing.prohibited.length > 0
      ? [issue('config.rule.routing_prohibited_none', `${base}.prohibited`)]
      : []),
  ];
};

const m9: Rule = (c) => {
  const { warn_percent: warn, stop_percent: stop } = c.budget;
  return [
    ...(warn > MAX_WARN_PERCENT
      ? [issue('config.rule.budget_warn_max', 'budget.warn_percent', { maximum: MAX_WARN_PERCENT })]
      : []),
    ...(stop > MAX_STOP_PERCENT
      ? [issue('config.rule.budget_stop_max', 'budget.stop_percent', { maximum: MAX_STOP_PERCENT })]
      : []),
    ...(warn >= stop ? [issue('config.rule.budget_warn_before_stop', 'budget.warn_percent')] : []),
  ];
};

const m10: Rule = (c) =>
  c.run.loop_detection.identical_tool_calls_max > MAX_IDENTICAL_TOOL_CALLS
    ? [
        issue('config.rule.loop_max', 'run.loop_detection.identical_tool_calls_max', {
          maximum: MAX_IDENTICAL_TOOL_CALLS,
        }),
      ]
    : [];

/**
 * True when clock `actual` can never run longer than `limit`. Working time runs no faster than wall
 * time, so a wall-clock value may replace a working-time limit of at least the same minutes, but a
 * working-time value never replaces a wall-clock limit.
 */
export function withinDeadline(
  actual: Deadline,
  limit: Deadline,
  calendar: WorkingCalendar,
): boolean {
  if ('kind' in limit) {
    return limit.kind === 'next_planned_work' || ('kind' in actual && actual.kind === limit.kind);
  }
  if ('kind' in actual) return false;
  if (isWorkingUnit(actual.unit) && !isWorkingUnit(limit.unit)) return false;
  return durationMinutes(actual, calendar) <= durationMinutes(limit, calendar);
}

function calendarFloor(calendar: WorkingCalendar): ConfigIssue[] {
  const path = 'escalation.calendar';
  const dayMinutes = workingDayMinutes(calendar);
  return [
    ...(calendar.working_days.length < MIN_WORKING_DAYS_PER_WEEK
      ? [
          issue('config.rule.calendar_min_working_days', `${path}.working_days`, {
            minimum: MIN_WORKING_DAYS_PER_WEEK,
            found: calendar.working_days.length,
          }),
        ]
      : []),
    ...(dayMinutes < MIN_WORKING_HOURS_PER_DAY * 60
      ? [
          issue('config.rule.calendar_min_working_hours', `${path}.working_hours`, {
            minimum: MIN_WORKING_HOURS_PER_DAY,
            found: dayMinutes,
          }),
        ]
      : []),
  ];
}

const slaClocks: Rule = (c) =>
  SEVERITIES.flatMap((severity) => {
    const actual = c.escalation.sla[severity];
    const limit = HANDBOOK_SLA[severity];
    const calendar = c.escalation.calendar;
    const clocks: [string, Deadline, Deadline][] = [
      ['acknowledge', actual.acknowledge, limit.acknowledge],
      ['resolve', actual.resolve, limit.resolve],
    ];
    return clocks
      .filter(([, value, max]) => !withinDeadline(value, max, calendar))
      .map(([clock, , max]) =>
        issue('config.rule.sla_longer', `escalation.sla.${severity}.${clock}`, {
          severity,
          clock,
          limit: describeDeadline(max),
        }),
      );
  });

const m11: Rule = (c) => [...calendarFloor(c.escalation.calendar), ...slaClocks(c)];

function describeDeadline(deadline: Deadline): string {
  return 'kind' in deadline ? deadline.kind : `${deadline.value} ${deadline.unit}`;
}

function cellStructure(ref: CellRef): ConfigIssue[] {
  const { cell, path, gate } = ref;
  const found: ConfigIssue[] = [];
  if (cell.mode === 'POLICY' && gate !== 'G4' && gate !== 'G6') {
    found.push(issue('config.rule.policy_only_g4', `${path}.mode`, { gate }));
  }
  if (cell.mode === 'POLICY' && cell.roles.length > 0)
    found.push(issue('config.rule.policy_no_roles', `${path}.roles`));
  if (cell.mode !== 'POLICY' && cell.roles.length === 0)
    found.push(issue('config.rule.roles_required', `${path}.roles`));
  if (cell.mode === 'HITL' && cell.approvals > cell.roles.length && cell.roles.length > 0) {
    found.push(issue('config.rule.approvals_exceed_roles', `${path}.approvals`));
  }
  if (cell.roles.includes('viewer'))
    found.push(issue('config.rule.viewer_never_approves', `${path}.roles`));
  if (cell.on_breach !== undefined && cell.on_breach !== 'HITL') {
    found.push(
      issue('config.rule.on_breach_stricter', `${path}.on_breach`, { found: cell.on_breach }),
    );
  }
  return found;
}

const m12: Rule = (c) => [
  ...matrixCells(c).flatMap(cellStructure),
  ...(c.oversight.dual_approval_g7.roles.includes('viewer')
    ? [issue('config.rule.viewer_never_approves', 'oversight.dual_approval_g7.roles')]
    : []),
];

const m13: Rule = (c) => [
  ...requireHitl(
    cellsOf(c, ['G2', 'G3', 'G6', 'G8.production'], HIGH_RISK),
    'config.rule.high_risk_hitl',
  ),
  ...requireHitl(cellsOf(c, ['G8.non_production'], ['critical']), 'config.rule.high_risk_hitl'),
];

const m14: Rule = (c) =>
  requireHitl(cellsOf(c, ['G4'], HIGH_RISK), 'config.rule.g4_high_risk_hitl');

const m15: Rule = (c) =>
  cellsOf(c, ['G6'])
    .filter((ref) => ref.cell.mode === 'POLICY')
    .map((ref) =>
      issue('config.rule.g6_independent_verification', `${ref.path}.mode`, { tier: ref.tier }),
    );

const m16: Rule = (c) =>
  c.access.intent_create_roles.includes('viewer')
    ? [issue('config.rule.viewer_never_creates', 'access.intent_create_roles')]
    : [];

/** The last step of every escalation; also owns the `policy` route (handbook Ch.6 §6.4). */
export const ESCALATION_FINAL_ROLE: ProjectRole = 'governance';

/** Who must be told when an escalation is raised (handbook Ch.6 §6.4 SLA table "Notify"). */
export const HANDBOOK_NOTIFY_ON_RAISE: Readonly<Record<Severity, readonly ProjectRole[]>> = {
  critical: ['governance', 'person_a', 'person_b'],
  high: ['governance', 'person_a', 'person_b'],
  medium: ['person_a', 'person_b'],
  low: ['person_a'],
};

function routingIssues(route: EscalationRoute, config: ProjectConfig): ConfigIssue[] {
  const { owner_role: owner, backup_role: backup } = config.escalation.routing[route];
  const path = `escalation.routing.${route}`;
  const found: ConfigIssue[] = [];
  if (owner === 'viewer') found.push(issue('config.rule.escalation_viewer', `${path}.owner_role`));
  if (backup === 'viewer') {
    found.push(issue('config.rule.escalation_viewer', `${path}.backup_role`));
  }
  if (backup !== null && backup === owner) {
    found.push(issue('config.rule.escalation_backup_same', `${path}.backup_role`, { route }));
  }
  if (route === 'policy' && owner !== ESCALATION_FINAL_ROLE) {
    found.push(
      issue('config.rule.escalation_policy_owner', `${path}.owner_role`, {
        role: ESCALATION_FINAL_ROLE,
        found: owner,
      }),
    );
  }
  return found;
}

const m17: Rule = (c) => [
  ...ESCALATION_ROUTES.flatMap((route) => routingIssues(route, c)),
  ...SEVERITIES.flatMap((severity) =>
    missingItems(HANDBOOK_NOTIFY_ON_RAISE[severity], c.escalation.notify_on_raise[severity]).map(
      (role) =>
        issue('config.rule.escalation_notify_missing', `escalation.notify_on_raise.${severity}`, {
          severity,
          role,
        }),
    ),
  ),
  ...SEVERITIES.flatMap((severity) =>
    c.escalation.notify_on_raise[severity].includes('viewer')
      ? [issue('config.rule.escalation_viewer', `escalation.notify_on_raise.${severity}`)]
      : [],
  ),
];

const m18: Rule = (c) =>
  c.agents.recertification_months > MAX_RECERTIFICATION_MONTHS
    ? [
        issue('config.rule.recertification_max', 'agents.recertification_months', {
          maximum: MAX_RECERTIFICATION_MONTHS,
        }),
      ]
    : [];

const m19: Rule = (c) =>
  c.access.ai_record_write_roles.includes('viewer')
    ? [issue('config.rule.viewer_never_writes_ai_record', 'access.ai_record_write_roles')]
    : [];

/** Response levels that freeze the intent from creation (ADR-M28 §2.4). */
const FREEZING_LEVELS: readonly ResponseLevel[] = ['pause', 'contain', 'incident'];

const m20: Rule = (c) =>
  FREEZING_LEVELS.includes(c.run.failed_run_escalation.response_level)
    ? []
    : [
        issue(
          'config.rule.failed_run_escalation_freezes',
          'run.failed_run_escalation.response_level',
          { found: c.run.failed_run_escalation.response_level },
        ),
      ];

/** The pair that `access.conflicting_roles` must always hold (rule M21). */
export const ALWAYS_CONFLICTING_ROLES: readonly ProjectRole[] = ['person_a', 'person_b'];

const m21: Rule = (c) =>
  c.access.conflicting_roles.some(
    (pair) =>
      pair.length === ALWAYS_CONFLICTING_ROLES.length &&
      ALWAYS_CONFLICTING_ROLES.every((role) => pair.includes(role)),
  )
    ? []
    : [issue('config.rule.person_a_person_b_conflict', 'access.conflicting_roles')];

const m22: Rule = (c) =>
  FREEZING_LEVELS.includes(c.run.g5_breach_escalation.response_level)
    ? []
    : [
        issue(
          'config.rule.g5_breach_escalation_freezes',
          'run.g5_breach_escalation.response_level',
          { found: c.run.g5_breach_escalation.response_level },
        ),
      ];

const m23: Rule = (c) =>
  c.access.spec_link_roles.includes('viewer')
    ? [issue('config.rule.viewer_never_links_spec', 'access.spec_link_roles')]
    : [];

type Rule = (config: ProjectConfig) => ConfigIssue[];

export const MANDATORY_RULES: Readonly<Record<string, Rule>> = {
  M1: m1,
  M2: m2,
  M3: m3,
  M4: m4,
  M5: m5,
  M6: m6,
  M7: m7,
  M8: m8,
  M9: m9,
  M10: m10,
  M11: m11,
  M12: m12,
  M13: m13,
  M14: m14,
  M15: m15,
  M16: m16,
  M17: m17,
  M18: m18,
  M19: m19,
  M20: m20,
  M21: m21,
  M22: m22,
  M23: m23,
};

/** All mandatory-rule violations; each issue carries its rule id as the `rule` parameter. */
export function checkMandatoryRules(config: ProjectConfig): ConfigIssue[] {
  return Object.entries(MANDATORY_RULES).flatMap(([rule, check]) =>
    check(config).map((found) => ({ ...found, params: { ...found.params, rule } })),
  );
}
