// D-08 A05 AC2: validation refuses configurations that loosen mandatory rules, with clear messages
// from the message catalog. Rules M1–M15: platform/packages/config/src/mandatory-rules.ts.
import { formatIssue, MANDATORY_RULES } from '@sdlc/config';
import { describe, expect, it } from 'vitest';

import { loadErrors, loadValid } from './helpers';

const cell = (gate: string, tier: string, body: string) =>
  `oversight:\n  matrix:\n    ${gate}:\n      ${tier}: ${body}\n`;
const g8 = (env: string, tier: string, body: string) =>
  `oversight:\n  matrix:\n    G8:\n      ${env}:\n        ${tier}: ${body}\n`;
const sla = (severity: string, clock: string, body: string) =>
  `escalation:\n  sla:\n    ${severity}:\n      ${clock}: ${body}\n`;

interface Case {
  name: string;
  rule: string;
  yaml: string;
  key: string;
  path: string;
}

const CASES: Case[] = [
  // M1: G1 HITL at every tier.
  {
    name: 'G1 low as HOTL',
    rule: 'M1',
    yaml: cell('G1', 'low', '{ mode: HOTL }'),
    key: 'config.rule.g1_hitl',
    path: 'oversight.matrix.G1.low.mode',
  },
  {
    name: 'G1 critical as AUDIT',
    rule: 'M1',
    yaml: cell('G1', 'critical', '{ mode: AUDIT }'),
    key: 'config.rule.g1_hitl',
    path: 'oversight.matrix.G1.critical.mode',
  },
  // M2: G7 HITL at every tier, Person B, Critical dual approval.
  {
    name: 'G7 low as HOTL',
    rule: 'M2',
    yaml: cell('G7', 'low', '{ mode: HOTL }'),
    key: 'config.rule.g7_hitl',
    path: 'oversight.matrix.G7.low.mode',
  },
  {
    name: 'G7 without Person B',
    rule: 'M2',
    yaml: cell('G7', 'medium', '{ roles: [person_a] }'),
    key: 'config.rule.person_b_required',
    path: 'oversight.matrix.G7.medium.roles',
  },
  {
    name: 'G7 critical with one approval',
    rule: 'M2',
    yaml: cell('G7', 'critical', '{ approvals: 1 }'),
    key: 'config.rule.critical_dual_approval',
    path: 'oversight.matrix.G7.critical',
  },
  {
    name: 'G7 critical without the second approver',
    rule: 'M2',
    yaml: cell('G7', 'critical', '{ roles: [person_b, governance] }'),
    key: 'config.rule.critical_dual_approval',
    path: 'oversight.matrix.G7.critical',
  },
  // M3: G8 production HITL, Person B, Critical dual approval (both environments).
  {
    name: 'G8 production low as HOTL',
    rule: 'M3',
    yaml: g8('production', 'low', '{ mode: HOTL }'),
    key: 'config.rule.g8_production_hitl',
    path: 'oversight.matrix.G8.production.low.mode',
  },
  {
    name: 'G8 production without Person B',
    rule: 'M3',
    yaml: g8('production', 'high', '{ roles: [governance] }'),
    key: 'config.rule.person_b_required',
    path: 'oversight.matrix.G8.production.high.roles',
  },
  {
    name: 'G8 non-production critical with one approval',
    rule: 'M3',
    yaml: g8('non_production', 'critical', '{ approvals: 1 }'),
    key: 'config.rule.critical_dual_approval',
    path: 'oversight.matrix.G8.non_production.critical',
  },
  // M4, M5: handbook change-flag lists.
  {
    name: 'forced-HITL list without migration',
    rule: 'M4',
    yaml: 'oversight:\n  forced_hitl_g3:\n    change_flags: [breaking_contract, new_service_boundary, security_boundary, system_of_record, prod_infrastructure, core_business_rule]\n',
    key: 'config.rule.forced_hitl_flag_missing',
    path: 'oversight.forced_hitl_g3.change_flags',
  },
  {
    name: 'dual-approval list without personal_data',
    rule: 'M5',
    yaml: 'oversight:\n  dual_approval_g7:\n    change_flags: [migration, payment, prod_infrastructure, breaking_contract, safety_function]\n',
    key: 'config.rule.dual_approval_flag_missing',
    path: 'oversight.dual_approval_g7.change_flags',
  },
  {
    name: 'dual-approval roles without the second approver',
    rule: 'M5',
    yaml: 'oversight:\n  dual_approval_g7:\n    roles: [person_b, governance]\n',
    key: 'config.rule.dual_approval_role_missing',
    path: 'oversight.dual_approval_g7.roles',
  },
  // M6: security findings at G6.
  {
    name: 'security findings as HOTL',
    rule: 'M6',
    yaml: 'oversight:\n  g6_security_findings: HOTL\n',
    key: 'config.rule.g6_security_hitl',
    path: 'oversight.g6_security_findings',
  },
  // M7: autonomy.
  {
    name: 'low risk at L3',
    rule: 'M7',
    yaml: 'autonomy:\n  max_by_risk: { low: L3 }\n',
    key: 'config.rule.autonomy_above_mvp',
    path: 'autonomy.max_by_risk.low',
  },
  {
    name: 'critical risk at L1',
    rule: 'M7',
    yaml: 'autonomy:\n  max_by_risk: { critical: L1 }\n',
    key: 'config.rule.autonomy_critical_l0',
    path: 'autonomy.max_by_risk.critical',
  },
  {
    name: 'high risk at L2',
    rule: 'M7',
    yaml: 'autonomy:\n  max_by_risk: { high: L2 }\n',
    key: 'config.rule.autonomy_high_l1',
    path: 'autonomy.max_by_risk.high',
  },
  {
    name: 'medium risk above low risk',
    rule: 'M7',
    yaml: 'autonomy:\n  max_by_risk: { low: L1, medium: L2 }\n',
    key: 'config.rule.autonomy_order',
    path: 'autonomy.max_by_risk.medium',
  },
  // M8: model routing.
  {
    name: 'client_restricted data to API models',
    rule: 'M8',
    yaml: 'model_routing:\n  allowed_provider_types:\n    client_restricted: [self_hosted, api]\n',
    key: 'config.rule.routing_restricted_self_hosted',
    path: 'model_routing.allowed_provider_types.client_restricted',
  },
  {
    name: 'prohibited data to a model',
    rule: 'M8',
    yaml: 'model_routing:\n  allowed_provider_types:\n    prohibited: [self_hosted]\n',
    key: 'config.rule.routing_prohibited_none',
    path: 'model_routing.allowed_provider_types.prohibited',
  },
  // M9: budget thresholds.
  {
    name: 'warning at 90 %',
    rule: 'M9',
    yaml: 'budget:\n  warn_percent: 90\n',
    key: 'config.rule.budget_warn_max',
    path: 'budget.warn_percent',
  },
  {
    name: 'stop at 120 %',
    rule: 'M9',
    yaml: 'budget:\n  stop_percent: 120\n',
    key: 'config.rule.budget_stop_max',
    path: 'budget.stop_percent',
  },
  {
    name: 'warning after the stop',
    rule: 'M9',
    yaml: 'budget:\n  warn_percent: 70\n  stop_percent: 60\n',
    key: 'config.rule.budget_warn_before_stop',
    path: 'budget.warn_percent',
  },
  // M10: loop detection.
  {
    name: 'loop limit 5',
    rule: 'M10',
    yaml: 'run:\n  loop_detection:\n    identical_tool_calls_max: 5\n',
    key: 'config.rule.loop_max',
    path: 'run.loop_detection.identical_tool_calls_max',
  },
  // M11: SLA clocks.
  {
    name: 'critical acknowledge 30 minutes',
    rule: 'M11',
    yaml: sla('critical', 'acknowledge', '{ value: 30, unit: minutes }'),
    key: 'config.rule.sla_longer',
    path: 'escalation.sla.critical.acknowledge',
  },
  {
    name: 'high acknowledge in working time',
    rule: 'M11',
    yaml: sla('high', 'acknowledge', '{ value: 1, unit: working_hours }'),
    key: 'config.rule.sla_longer',
    path: 'escalation.sla.high.acknowledge',
  },
  {
    name: 'medium resolve 4 working days',
    rule: 'M11',
    yaml: sla('medium', 'resolve', '{ value: 4, unit: working_days }'),
    key: 'config.rule.sla_longer',
    path: 'escalation.sla.medium.resolve',
  },
  {
    name: 'high resolve without a clock',
    rule: 'M11',
    yaml: sla('high', 'resolve', '{ kind: next_planned_work }'),
    key: 'config.rule.sla_longer',
    path: 'escalation.sla.high.resolve',
  },
  {
    name: 'critical resolve at the end of the day',
    rule: 'M11',
    yaml: sla('critical', 'resolve', '{ kind: end_of_working_day }'),
    key: 'config.rule.sla_longer',
    path: 'escalation.sla.critical.resolve',
  },
  // M12: cell structure.
  {
    name: 'POLICY at G5',
    rule: 'M12',
    yaml: cell('G5', 'low', '{ mode: POLICY, roles: [] }'),
    key: 'config.rule.policy_only_g4',
    path: 'oversight.matrix.G5.low.mode',
  },
  {
    name: 'POLICY with roles',
    rule: 'M12',
    yaml: cell('G4', 'low', '{ roles: [person_a] }'),
    key: 'config.rule.policy_no_roles',
    path: 'oversight.matrix.G4.low.roles',
  },
  {
    name: 'HOTL with nobody to notify',
    rule: 'M12',
    yaml: cell('G2', 'low', '{ roles: [] }'),
    key: 'config.rule.roles_required',
    path: 'oversight.matrix.G2.low.roles',
  },
  {
    name: 'more approvals than roles',
    rule: 'M12',
    yaml: cell('G3', 'medium', '{ approvals: 2 }'),
    key: 'config.rule.approvals_exceed_roles',
    path: 'oversight.matrix.G3.medium.approvals',
  },
  {
    name: 'viewer as approver',
    rule: 'M12',
    yaml: cell('G3', 'medium', '{ roles: [person_b, viewer] }'),
    key: 'config.rule.viewer_never_approves',
    path: 'oversight.matrix.G3.medium.roles',
  },
  {
    name: 'on_breach that is not stricter',
    rule: 'M12',
    yaml: cell('G5', 'high', '{ on_breach: AUDIT }'),
    key: 'config.rule.on_breach_stricter',
    path: 'oversight.matrix.G5.high.on_breach',
  },
  // M13: human approval of high-risk effects.
  {
    name: 'G2 high as HOTL',
    rule: 'M13',
    yaml: cell('G2', 'high', '{ mode: HOTL }'),
    key: 'config.rule.high_risk_hitl',
    path: 'oversight.matrix.G2.high.mode',
  },
  {
    name: 'G3 critical as HOTL',
    rule: 'M13',
    yaml: cell('G3', 'critical', '{ mode: HOTL }'),
    key: 'config.rule.high_risk_hitl',
    path: 'oversight.matrix.G3.critical.mode',
  },
  {
    name: 'G6 high as HOTL',
    rule: 'M13',
    yaml: cell('G6', 'high', '{ mode: HOTL }'),
    key: 'config.rule.high_risk_hitl',
    path: 'oversight.matrix.G6.high.mode',
  },
  {
    name: 'G8 non-production critical as HOTL',
    rule: 'M13',
    yaml: g8('non_production', 'critical', '{ mode: HOTL, approvals: 2 }'),
    key: 'config.rule.high_risk_hitl',
    path: 'oversight.matrix.G8.non_production.critical.mode',
  },
  // M14: permission before dangerous actions.
  {
    name: 'G4 high as POLICY',
    rule: 'M14',
    yaml: cell('G4', 'high', '{ mode: POLICY, roles: [] }'),
    key: 'config.rule.g4_high_risk_hitl',
    path: 'oversight.matrix.G4.high.mode',
  },
  // M15: independent verification.
  {
    name: 'G6 low as POLICY',
    rule: 'M15',
    yaml: cell('G6', 'low', '{ mode: POLICY, roles: [] }'),
    key: 'config.rule.g6_independent_verification',
    path: 'oversight.matrix.G6.low.mode',
  },
];

describe('mandatory rules refuse loosening (AC2)', () => {
  it.each(CASES)('$rule: $name', ({ rule, yaml, key, path }) => {
    const errors = loadErrors(yaml);
    const match = errors.find((e) => e.key === key && e.path === path);
    expect(match, errors.map((e) => formatIssue(e)).join('\n')).toBeDefined();
    expect(match?.params.rule).toBe(rule);
  });

  it('has at least one test case for every rule', () => {
    const tested = new Set(CASES.map((c) => c.rule));
    expect(Object.keys(MANDATORY_RULES).filter((rule) => !tested.has(rule))).toEqual([]);
  });

  it('renders every refusal completely from the catalog', () => {
    for (const { yaml } of CASES) {
      for (const error of loadErrors(yaml)) {
        const text = formatIssue(error);
        expect(text, text).not.toMatch(/\{[a-z_]+\}/);
        expect(text.startsWith(`${error.path}: `)).toBe(true);
      }
    }
  });

  it('gives a clear English message', () => {
    const [error] = loadErrors(cell('G1', 'low', '{ mode: HOTL }'));
    expect(formatIssue(error!)).toBe(
      'oversight.matrix.G1.low.mode: G1 must be HITL at every risk tier; found HOTL for low (rule M1, codes table §4).',
    );
  });
});

describe('tightening is always allowed (AC2)', () => {
  it.each([
    ['G2 low HOTL → HITL', cell('G2', 'low', '{ mode: HITL }')],
    ['G4 low POLICY → HITL', cell('G4', 'low', '{ mode: HITL, roles: [person_a] }')],
    ['G6 low AUDIT → HOTL', cell('G6', 'low', '{ mode: HOTL }')],
    ['G5 medium with on_breach HITL', cell('G5', 'medium', '{ on_breach: HITL }')],
    [
      'G7 medium with two approvals',
      cell('G7', 'medium', '{ roles: [person_b, second_approver], approvals: 2 }'),
    ],
    ['medium risk at L1', 'autonomy:\n  max_by_risk: { medium: L1 }\n'],
    ['warning at 70 %, stop at 90 %', 'budget:\n  warn_percent: 70\n  stop_percent: 90\n'],
    ['loop limit 2', 'run:\n  loop_detection:\n    identical_tool_calls_max: 2\n'],
    [
      'critical acknowledge 10 minutes',
      sla('critical', 'acknowledge', '{ value: 10, unit: minutes }'),
    ],
    [
      'medium acknowledge 4 wall-clock hours',
      sla('medium', 'acknowledge', '{ value: 4, unit: hours }'),
    ],
    ['medium resolve 2 working days', sla('medium', 'resolve', '{ value: 2, unit: working_days }')],
    [
      'low resolve 5 working days (was no clock)',
      sla('low', 'resolve', '{ value: 5, unit: working_days }'),
    ],
    ['G5 high set to HITL (on_breach HITL stays)', cell('G5', 'high', '{ mode: HITL }')],
    [
      'internal data self-hosted only',
      'model_routing:\n  allowed_provider_types:\n    internal: [self_hosted]\n',
    ],
  ])('%s', (_name, yaml) => {
    const { warnings } = loadValid(yaml);
    expect(warnings).toEqual([]);
  });
});

describe('allowed loosening is reported as a warning (ADR-M13)', () => {
  it('warns when a non-mandatory cell is loosened', () => {
    const { warnings } = loadValid(cell('G2', 'medium', '{ mode: HOTL }'));
    expect(warnings.map((w) => [w.key, w.path])).toEqual([
      ['config.warning.mode_loosened', 'oversight.matrix.G2.medium.mode'],
    ]);
    expect(formatIssue(warnings[0]!)).toBe(
      'oversight.matrix.G2.medium.mode: oversight loosened from HITL (codes table default) to HOTL. This change must be reviewed.',
    );
  });

  it('warns when working days are removed or working hours are shortened', () => {
    const { warnings } = loadValid(
      "escalation:\n  calendar:\n    working_days: [mon, tue, wed, thu]\n    working_hours: { start: '09:00', end: '17:00' }\n",
    );
    expect(warnings.map((w) => [w.key, w.path, w.params])).toEqual([
      ['config.warning.working_day_removed', 'escalation.calendar.working_days', { day: 'fri' }],
      [
        'config.warning.working_hours_shortened',
        'escalation.calendar.working_hours',
        { from: 540, to: 480 },
      ],
    ]);
  });

  it('gives no warning for holidays or a longer working day', () => {
    const { warnings } = loadValid(
      "escalation:\n  calendar:\n    holidays: [2027-02-05, 2027-02-08]\n    working_days: [mon, tue, wed, thu, fri, sat]\n    working_hours: { start: '08:00', end: '18:00' }\n",
    );
    expect(warnings).toEqual([]);
  });

  it('warns when a G3 cell moves from HITL to HOTL at Medium risk', () => {
    const { warnings } = loadValid(cell('G3', 'medium', '{ mode: HOTL }'));
    expect(warnings.map((w) => w.key)).toEqual(['config.warning.mode_loosened']);
  });
});
