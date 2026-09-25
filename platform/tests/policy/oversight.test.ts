// D-08 B01 AC2: oversight resolution (design/D-03 section 6.1, D-02 FR-14…FR-16).
// The expected table is written out from handbook codes table §4 and D-02 §6.2 (approvers). It is
// not read from the default config file, so it checks the file and the engine together.
import type {
  ChangeFlag,
  GateCode,
  OversightResolution,
  ProjectRole,
  RiskTier,
  Severity,
} from '@sdlc/contracts';
import { CHANGE_FLAGS, GATE_CODES, RISK_TIERS, SEVERITIES } from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

import { engineFor } from './helpers';

type Row = [
  gate: GateCode,
  env: 'production' | 'non_production' | null,
  tier: RiskTier,
  mode: string,
  approvals: number,
  roles: ProjectRole[],
];

const A: ProjectRole[] = ['person_a'];
const B: ProjectRole[] = ['person_b'];
const B2: ProjectRole[] = ['person_b', 'second_approver'];

// prettier-ignore
const CODES_TABLE: Row[] = [
  ['G1', null, 'low', 'HITL', 1, A], ['G1', null, 'medium', 'HITL', 1, A],
  ['G1', null, 'high', 'HITL', 1, A], ['G1', null, 'critical', 'HITL', 1, A],
  ['G2', null, 'low', 'HOTL', 0, A], ['G2', null, 'medium', 'HITL', 1, A],
  ['G2', null, 'high', 'HITL', 1, B], ['G2', null, 'critical', 'HITL', 1, B],
  ['G3', null, 'low', 'HOTL', 0, B], ['G3', null, 'medium', 'HITL', 1, B],
  ['G3', null, 'high', 'HITL', 1, B], ['G3', null, 'critical', 'HITL', 1, B],
  ['G4', null, 'low', 'POLICY', 0, []], ['G4', null, 'medium', 'POLICY', 0, []],
  ['G4', null, 'high', 'HITL', 1, A], ['G4', null, 'critical', 'HITL', 1, A],
  ['G5', null, 'low', 'HOTL', 0, A], ['G5', null, 'medium', 'HOTL', 0, A],
  ['G5', null, 'high', 'HOTL', 0, A], ['G5', null, 'critical', 'HITL', 1, A],
  ['G6', null, 'low', 'AUDIT', 0, B], ['G6', null, 'medium', 'HOTL', 0, B],
  ['G6', null, 'high', 'HITL', 1, B], ['G6', null, 'critical', 'HITL', 1, B],
  ['G7', null, 'low', 'HITL', 1, B], ['G7', null, 'medium', 'HITL', 1, B],
  ['G7', null, 'high', 'HITL', 1, B], ['G7', null, 'critical', 'HITL', 2, B2],
  ['G8', 'production', 'low', 'HITL', 1, B], ['G8', 'production', 'medium', 'HITL', 1, B],
  ['G8', 'production', 'high', 'HITL', 1, B], ['G8', 'production', 'critical', 'HITL', 2, B2],
  ['G8', 'non_production', 'low', 'HOTL', 0, B], ['G8', 'non_production', 'medium', 'HOTL', 0, B],
  ['G8', 'non_production', 'high', 'HOTL', 0, B], ['G8', 'non_production', 'critical', 'HITL', 2, B2],
];

const engine = engineFor();

function resolve(
  gate: GateCode,
  riskTier: RiskTier,
  changeFlags: readonly ChangeFlag[] = [],
  context = {},
  policy = engine,
): OversightResolution {
  return policy.oversightMode({ gate, riskTier, changeFlags, context });
}

describe('default matrix, every gate × risk tier (codes table §4)', () => {
  it('covers all 8 gates, both G8 environments and all 4 tiers', () => {
    expect(CODES_TABLE).toHaveLength((GATE_CODES.length + 1) * RISK_TIERS.length);
  });

  it.each(CODES_TABLE)('%s %s %s → %s', (gate, env, tier, mode, approvals, roles) => {
    const context = env === null ? {} : { environment: env };
    expect(resolve(gate, tier, [], context)).toEqual({
      mode,
      approvalsNeeded: approvals,
      roles,
      overrides: [],
    });
  });

  it('uses the production table for G8 when no environment is given', () => {
    for (const tier of RISK_TIERS) {
      expect(resolve('G8', tier)).toEqual(resolve('G8', tier, [], { environment: 'production' }));
    }
  });
});

const FORCED_G3: ChangeFlag[] = [
  'migration',
  'breaking_contract',
  'new_service_boundary',
  'security_boundary',
  'system_of_record',
  'prod_infrastructure',
  'core_business_rule',
];
const DUAL_G7: ChangeFlag[] = [
  'migration',
  'payment',
  'personal_data',
  'prod_infrastructure',
  'breaking_contract',
  'safety_function',
];

describe('forced HITL at G3 (FR-15)', () => {
  const cases = RISK_TIERS.flatMap((tier) => FORCED_G3.map((flag) => [tier, flag] as const));

  it.each(cases)('G3 %s with %s → HITL, Person B', (tier, flag) => {
    expect(resolve('G3', tier, [flag])).toEqual({
      mode: 'HITL',
      approvalsNeeded: 1,
      roles: B,
      overrides: ['forced_hitl_change_flag'],
    });
  });

  it('keeps HOTL at Low for flags that are not on the forced list', () => {
    const others = CHANGE_FLAGS.filter((flag) => !FORCED_G3.includes(flag));
    expect(others.length).toBeGreaterThan(0);
    for (const flag of others) expect(resolve('G3', 'low', [flag]).mode).toBe('HOTL');
  });

  it('does not change other gates', () => {
    expect(resolve('G2', 'low', ['migration']).mode).toBe('HOTL');
  });
});

describe('dual approval at G7 (FR-16)', () => {
  const cases = RISK_TIERS.flatMap((tier) => DUAL_G7.map((flag) => [tier, flag] as const));

  it.each(cases)('G7 %s with %s → 2 approvals, Person B + second approver', (tier, flag) => {
    expect(resolve('G7', tier, [flag])).toEqual({
      mode: 'HITL',
      approvalsNeeded: 2,
      roles: B2,
      overrides: ['dual_approval_change_flag'],
    });
  });

  it('needs one approval at Low to High for flags that are not on the dual list', () => {
    const others = CHANGE_FLAGS.filter((flag) => !DUAL_G7.includes(flag));
    for (const tier of ['low', 'medium', 'high'] as const) {
      for (const flag of others) expect(resolve('G7', tier, [flag]).approvalsNeeded).toBe(1);
    }
  });

  it('needs two approvals at Critical without any flag', () => {
    expect(resolve('G7', 'critical').approvalsNeeded).toBe(2);
  });
});

describe('security findings at G6 (codes table §4, QUESTIONS.md #19)', () => {
  const atOrAbove: Severity[] = ['critical', 'high'];
  const below: Severity[] = ['medium', 'low'];
  const matrixMode = (tier: RiskTier) => resolve('G6', tier).mode;

  it.each(RISK_TIERS.flatMap((t) => atOrAbove.map((s) => [t, s] as const)))(
    'G6 %s with one %s finding → HITL',
    (tier, severity) => {
      expect(resolve('G6', tier, [], { securityFindings: { [severity]: 1 } })).toEqual({
        mode: 'HITL',
        approvalsNeeded: 1,
        roles: B,
        overrides: ['security_finding'],
      });
    },
  );

  it.each(RISK_TIERS.flatMap((t) => below.map((s) => [t, s] as const)))(
    'G6 %s with %s findings below the threshold keeps the matrix mode',
    (tier, severity) => {
      const found = resolve('G6', tier, [], { securityFindings: { [severity]: 5 } });
      expect(found.mode).toBe(matrixMode(tier));
      expect(found.overrides).toEqual([]);
    },
  );

  it('ignores zero counts', () => {
    expect(resolve('G6', 'low', [], { securityFindings: { critical: 0 } }).mode).toBe('AUDIT');
  });

  it('follows a stricter project threshold', () => {
    const strict = engineFor('oversight:\n  g6_security_findings: { min_severity: low }\n');
    expect(resolve('G6', 'low', [], { securityFindings: { low: 1 } }, strict).mode).toBe('HITL');
  });

  it('still makes a critical finding HITL with the loosest threshold', () => {
    const loose = engineFor('oversight:\n  g6_security_findings: { min_severity: critical }\n');
    expect(resolve('G6', 'low', [], { securityFindings: { high: 3 } }, loose).mode).toBe('AUDIT');
    expect(resolve('G6', 'low', [], { securityFindings: { critical: 1 } }, loose).mode).toBe(
      'HITL',
    );
  });

  it('only applies to G6', () => {
    for (const severity of SEVERITIES) {
      expect(resolve('G5', 'low', [], { securityFindings: { [severity]: 1 } }).mode).toBe('HOTL');
    }
  });
});

describe('G5 breach (codes table §4 "HOTL → HITL on breach")', () => {
  it('turns G5 High into HITL on a breach', () => {
    expect(resolve('G5', 'high', [], { breached: true })).toEqual({
      mode: 'HITL',
      approvalsNeeded: 1,
      roles: A,
      overrides: ['limit_breached'],
    });
  });

  it('keeps Low and Medium HOTL (no on_breach in the matrix)', () => {
    expect(resolve('G5', 'low', [], { breached: true }).mode).toBe('HOTL');
    expect(resolve('G5', 'medium', [], { breached: true }).mode).toBe('HOTL');
  });
});

describe('values come from the project configuration, not code (AP5, ADR-M13)', () => {
  it('follows a tightened matrix cell', () => {
    const policy = engineFor('oversight:\n  matrix:\n    G2:\n      low: { mode: HITL }\n');
    expect(resolve('G2', 'low', [], {}, policy)).toMatchObject({
      mode: 'HITL',
      approvalsNeeded: 1,
    });
  });

  it('follows a forced-HITL flag added by the project', () => {
    const flags = [...FORCED_G3, 'payment'].join(', ');
    const policy = engineFor(`oversight:\n  forced_hitl_g3:\n    change_flags: [${flags}]\n`);
    expect(resolve('G3', 'low', ['payment'], {}, policy).mode).toBe('HITL');
  });

  it('follows a dual-approval flag added by the project', () => {
    const flags = [...DUAL_G7, 'core_business_rule'].join(', ');
    const policy = engineFor(`oversight:\n  dual_approval_g7:\n    change_flags: [${flags}]\n`);
    expect(resolve('G7', 'low', ['core_business_rule'], {}, policy).approvalsNeeded).toBe(2);
  });

  it('follows a looser, allowed cell (a warning at load time)', () => {
    const policy = engineFor('oversight:\n  matrix:\n    G3:\n      medium: { mode: HOTL }\n');
    expect(resolve('G3', 'medium', [], {}, policy).mode).toBe('HOTL');
  });
});
