// Gate decision rules that configuration cannot change: D-02 FR-11, design/D-03 section 6
// (no approval by silence), QUESTIONS #6 (POLICY at G4) and #21 (a G5 breach never passes).
import type { GateCheckMode, GateDecision } from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

import {
  decisionViolation,
  type DecisionFacts,
} from '../../packages/core/src/registry/decision-rules.js';

const facts = (extra: Partial<DecisionFacts>): DecisionFacts => ({
  gate: 'G1',
  decision: 'approve',
  actorType: 'human',
  mode: 'HITL',
  reasonCode: null,
  ...extra,
});

describe('decisionViolation', () => {
  it('FR-11: agents never decide', () => {
    for (const decision of ['approve', 'pass', 'reject'] as const) {
      expect(decisionViolation(facts({ actorType: 'agent', decision }))).toBe(
        'agent_never_decides',
      );
    }
  });

  it('humans and the system record different decisions; only the workflow writes void', () => {
    expect(decisionViolation(facts({ decision: 'pass' }))).toBe('decision_not_for_actor');
    expect(decisionViolation(facts({ actorType: 'system', decision: 'approve' }))).toBe(
      'decision_not_for_actor',
    );
    expect(
      decisionViolation(facts({ actorType: 'system', decision: 'void', reasonCode: 'expired' })),
    ).toBe('decision_not_for_actor');
  });

  it.each(['reject', 'request_changes', 'block'] as const)(
    '%s needs a reason code (never free text)',
    (decision) => {
      expect(decisionViolation(facts({ decision }))).toBe('reason_required');
      expect(decisionViolation(facts({ decision, reasonCode: 'spec_unclear' }))).toBeNull();
    },
  );

  it('fail needs a reason code', () => {
    const fail = facts({ actorType: 'system', decision: 'fail', mode: 'POLICY', gate: 'G4' });
    expect(decisionViolation(fail)).toBe('reason_required');
    expect(decisionViolation({ ...fail, reasonCode: 'policy_denied' })).toBeNull();
  });

  it('QUESTIONS #6: POLICY gates have no human decision; AUDIT gates have no human approval', () => {
    expect(decisionViolation(facts({ gate: 'G4', mode: 'POLICY' }))).toBe('no_human_decision');
    expect(
      decisionViolation(
        facts({ gate: 'G4', mode: 'POLICY', decision: 'block', reasonCode: 'other' }),
      ),
    ).toBe('no_human_decision');
    expect(decisionViolation(facts({ gate: 'G6', mode: 'AUDIT' }))).toBe('no_human_decision');
    // A sampling reviewer may still block at an AUDIT gate.
    expect(
      decisionViolation(
        facts({ gate: 'G6', mode: 'AUDIT', decision: 'block', reasonCode: 'tests_insufficient' }),
      ),
    ).toBeNull();
  });

  it.each<[GateCheckMode, ReturnType<typeof decisionViolation>]>([
    ['HITL', 'hitl_needs_a_person'],
    ['HOTL', null],
    ['AUDIT', null],
    ['POLICY', null],
  ])('a system pass at a %s gate -> %s (no approval by silence)', (mode, expected) => {
    expect(decisionViolation(facts({ actorType: 'system', decision: 'pass', mode }))).toBe(
      expected,
    );
  });

  it('QUESTIONS #21: a G5 breach never passes, whatever the mode', () => {
    for (const mode of ['HOTL', 'HITL', 'AUDIT'] as const) {
      expect(
        decisionViolation(
          facts({
            gate: 'G5',
            actorType: 'system',
            decision: 'pass',
            mode,
            context: { breached: true },
          }),
        ),
      ).toBe('breach_never_passes');
    }
    const stop: GateDecision[] = ['fail', 'block', 'pause'];
    for (const decision of stop) {
      expect(
        decisionViolation(
          facts({
            gate: 'G5',
            actorType: 'system',
            decision,
            mode: 'HOTL',
            reasonCode: 'budget_exceeded',
            context: { breached: true },
          }),
        ),
      ).toBeNull();
    }
    expect(
      decisionViolation(facts({ gate: 'G5', actorType: 'system', decision: 'pass', mode: 'HOTL' })),
    ).toBeNull();
  });
});
