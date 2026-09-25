// D-08 B01 AC3: who may approve (design/D-03 section 6.2, D-02 FR-11 and FR-16).
import type {
  ActorType,
  ApproverInput,
  ChangeFlag,
  GateCode,
  PriorApproval,
  ProjectRole,
  RiskTier,
} from '@sdlc/contracts';
import { GATE_CODES, RISK_TIERS } from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

import { engineFor } from './helpers';

const engine = engineFor();

interface Options {
  gate?: GateCode;
  tier?: RiskTier;
  flags?: ChangeFlag[];
  actor?: string;
  type?: ActorType;
  roles?: ProjectRole[];
  revoked?: ProjectRole[];
  producers?: string[];
  prior?: PriorApproval[];
  env?: 'production' | 'non_production';
}

function input(o: Options): ApproverInput {
  return {
    gate: o.gate ?? 'G7',
    actor: { id: o.actor ?? 'u-b', type: o.type ?? 'human' },
    roles: [
      ...(o.roles ?? ['person_b']).map((role) => ({ role, revokedAt: null })),
      ...(o.revoked ?? []).map((role) => ({ role, revokedAt: new Date('2026-09-01T00:00:00Z') })),
    ],
    intent: { riskTier: o.tier ?? 'medium', changeFlags: o.flags ?? [] },
    context: o.env === undefined ? {} : { environment: o.env },
    producers: o.producers ?? ['u-author', 'u-run-starter'],
    priorApprovals: o.prior ?? [],
  };
}

const approve = (o: Options) => engine.canApprove(input(o));

/** Every human-decided cell of the default matrix, with the first role that may approve it. */
const HUMAN_CELLS = GATE_CODES.flatMap((gate) =>
  RISK_TIERS.map((tier) => {
    const found = engine.oversightMode({ gate, riskTier: tier, changeFlags: [] });
    return { gate, tier, mode: found.mode, role: found.roles[0] };
  }),
).filter((cell) => cell.mode !== 'POLICY' && cell.mode !== 'AUDIT');

describe('role holders may approve (every human gate × tier)', () => {
  it.each(HUMAN_CELLS)('$gate $tier: $role may approve', ({ gate, tier, role }) => {
    expect(approve({ gate, tier, roles: [role!] })).toEqual({ allowed: true, role });
  });

  it.each(HUMAN_CELLS)('$gate $tier: a viewer may not', ({ gate, tier }) => {
    expect(approve({ gate, tier, roles: ['viewer'] })).toEqual({
      allowed: false,
      reason: 'role_missing',
    });
  });
});

describe('separation of duties (FR-11): never configurable', () => {
  it.each(HUMAN_CELLS)('$gate $tier: a producer never approves', ({ gate, tier, role }) => {
    for (const producer of ['u-author', 'u-run-starter']) {
      expect(approve({ gate, tier, actor: producer, roles: [role!] })).toEqual({
        allowed: false,
        reason: 'producer',
      });
    }
  });

  it.each(HUMAN_CELLS)(
    '$gate $tier: agents and the system never approve',
    ({ gate, tier, role }) => {
      for (const type of ['agent', 'system'] as const) {
        expect(approve({ gate, tier, type, roles: [role!] })).toEqual({
          allowed: false,
          reason: 'actor_not_human',
        });
      }
    },
  );

  it('refuses a producer at G7 even with every role (N5)', () => {
    const all: ProjectRole[] = ['person_a', 'person_b', 'second_approver', 'governance', 'admin'];
    expect(approve({ actor: 'u-author', roles: all })).toMatchObject({ reason: 'producer' });
  });

  it('refuses the wrong role (N5)', () => {
    expect(approve({ gate: 'G7', roles: ['person_a'] })).toMatchObject({ reason: 'role_missing' });
    expect(approve({ gate: 'G1', roles: ['person_b'] })).toMatchObject({ reason: 'role_missing' });
  });

  it('ignores revoked role bindings (QUESTIONS.md #11)', () => {
    expect(approve({ roles: [], revoked: ['person_b'] })).toEqual({
      allowed: false,
      reason: 'role_missing',
    });
    expect(approve({ roles: ['person_b'], revoked: ['person_b'] })).toMatchObject({
      allowed: true,
    });
  });

  it('lets the intent creator approve G1 unless the caller lists them as a producer (#16)', () => {
    expect(approve({ gate: 'G1', actor: 'u-creator', roles: ['person_a'] })).toMatchObject({
      allowed: true,
    });
    expect(
      approve({ gate: 'G7', actor: 'u-creator', producers: ['u-creator'], roles: ['person_b'] }),
    ).toMatchObject({ reason: 'producer' });
  });

  it('refuses any approval of a POLICY gate (G4 Low / Medium)', () => {
    for (const tier of ['low', 'medium'] as const) {
      expect(approve({ gate: 'G4', tier, roles: ['person_a'] })).toEqual({
        allowed: false,
        reason: 'no_human_decision',
      });
    }
  });

  it('refuses an approval of an AUDIT gate (G6 Low: sampled afterwards)', () => {
    expect(approve({ gate: 'G6', tier: 'low', roles: ['person_b'] })).toEqual({
      allowed: false,
      reason: 'no_human_decision',
    });
  });

  it('allows an explicit approval of a HOTL gate by a listed role (G2 Low)', () => {
    expect(approve({ gate: 'G2', tier: 'low', actor: 'u-a', roles: ['person_a'] })).toEqual({
      allowed: true,
      role: 'person_a',
    });
  });

  it('refuses the same person again even when their earlier role is no longer listed', () => {
    expect(approve({ actor: 'u-b', prior: [{ userId: 'u-b', role: 'governance' }] })).toMatchObject(
      { reason: 'already_approved' },
    );
  });

  it('refuses a second approval when one is enough', () => {
    const prior = [{ userId: 'u-b1', role: 'person_b' as const }];
    expect(approve({ actor: 'u-b2', prior })).toMatchObject({ reason: 'approvals_complete' });
  });
});

describe('dual approval: two different people (FR-16, N9)', () => {
  const dual = { gate: 'G7' as const, flags: ['personal_data' as const] };

  it('accepts Person B first, then the second approver', () => {
    expect(approve({ ...dual, actor: 'u-b' })).toEqual({ allowed: true, role: 'person_b' });
    expect(
      approve({
        ...dual,
        actor: 'u-2nd',
        roles: ['second_approver'],
        prior: [{ userId: 'u-b', role: 'person_b' }],
      }),
    ).toEqual({ allowed: true, role: 'second_approver' });
  });

  it('refuses the same person twice, even with both roles', () => {
    expect(
      approve({
        ...dual,
        actor: 'u-b',
        roles: ['person_b', 'second_approver'],
        prior: [{ userId: 'u-b', role: 'person_b' }],
      }),
    ).toEqual({ allowed: false, reason: 'already_approved' });
  });

  it('refuses a second Person B: the second approver role is still missing', () => {
    expect(
      approve({ ...dual, actor: 'u-b2', prior: [{ userId: 'u-b', role: 'person_b' }] }),
    ).toEqual({ allowed: false, reason: 'role_already_covered' });
  });

  it('gives a person holding both roles the role that is still open', () => {
    expect(
      approve({
        ...dual,
        actor: 'u-both',
        roles: ['person_b', 'second_approver'],
        prior: [{ userId: 'u-b', role: 'person_b' }],
      }),
    ).toEqual({ allowed: true, role: 'second_approver' });
  });

  it('refuses a third approval', () => {
    const prior = [
      { userId: 'u-b', role: 'person_b' as const },
      { userId: 'u-2nd', role: 'second_approver' as const },
    ];
    expect(approve({ ...dual, actor: 'u-x', roles: ['person_b'], prior })).toMatchObject({
      reason: 'approvals_complete',
    });
  });

  it('does not count a prior approval from a producer', () => {
    expect(
      approve({
        ...dual,
        actor: 'u-b',
        prior: [{ userId: 'u-author', role: 'second_approver' }],
      }),
    ).toEqual({ allowed: true, role: 'person_b' });
  });

  it('applies to Critical risk without a flag, at G7 and production G8', () => {
    for (const gate of ['G7', 'G8'] as const) {
      expect(
        approve({
          gate,
          tier: 'critical',
          actor: 'u-b2',
          prior: [{ userId: 'u-b', role: 'person_b' }],
        }),
      ).toMatchObject({ reason: 'role_already_covered' });
    }
  });
});
