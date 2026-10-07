// One oversight resolution for the workflow and the API's `waiting_for` (task U01, QUESTIONS #261,
// design/ADR-M54 §2.4). The cases the workflow treats apart from the plain matrix cell, and a
// static check that every gate step resolves through the shared function.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';
import { loadProjectConfig } from '@sdlc/config';
import type { GateCode, RiskTier } from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

import type { G6Facts } from '../../packages/core/src/workflow/g6-ci.js';
import { resolveGateOversight } from '../../packages/core/src/workflow/oversight.js';
import { repoRoot } from '../workspace/helpers';

const loaded = loadProjectConfig('');
if (!loaded.ok) throw new Error('default configuration must load');
const policy = createSimplePolicyEngine({ config: loaded.config });

const resolve = (
  gate: GateCode,
  risk: RiskTier,
  facts: Parameters<typeof resolveGateOversight>[3] = { changeFlags: [] },
) => resolveGateOversight(policy, { risk_tier: risk }, gate, facts);

function g6Facts(findings: 'known' | 'not_enabled', high = 0): G6Facts {
  return {
    ci: {
      findings,
      counts: { critical: 0, high, medium: 0, low: 0 },
      state: 'passed',
    },
  } as unknown as G6Facts;
}

describe('resolveGateOversight', () => {
  it('G2 at Low risk is HOTL; at Medium HITL', () => {
    expect(resolve('G2', 'low').mode).toBe('HOTL');
    expect(resolve('G2', 'medium').mode).toBe('HITL');
  });

  it('G3 is HITL at Low risk after G5, G6 or G7 sent the intent back', () => {
    expect(resolve('G3', 'low').mode).toBe('HOTL');
    const returned = resolve('G3', 'low', { changeFlags: [], returnedFromG5: true });
    expect(returned.mode).toBe('HITL');
    expect(returned.overrides).toContain('returned_from_g5');
  });

  it('G3 is HITL at Low risk for a forced-HITL change flag of the latest plan', () => {
    expect(resolve('G3', 'low', { changeFlags: ['migration'] }).mode).toBe('HITL');
  });

  it('G4 is POLICY at Low and Medium risk, HITL at High', () => {
    expect(resolve('G4', 'low').mode).toBe('POLICY');
    expect(resolve('G4', 'medium').mode).toBe('POLICY');
    expect(resolve('G4', 'high').mode).toBe('HITL');
    expect(resolve('G4', 'low').roles).toEqual([]);
  });

  it('G5 waits unbreached: HOTL', () => {
    expect(resolve('G5', 'medium').mode).toBe('HOTL');
  });

  it('G6 is HITL when the findings are unknown, whatever the tier', () => {
    expect(resolve('G6', 'low', { changeFlags: [], g6: g6Facts('known') }).mode).toBe('AUDIT');
    const unknown = resolve('G6', 'low', { changeFlags: [], g6: g6Facts('not_enabled') });
    expect(unknown.mode).toBe('HITL');
    expect(resolve('G6', 'low', { changeFlags: [], g6: null }).mode).toBe('HITL');
    expect(resolve('G6', 'low', { changeFlags: [], g6: g6Facts('known', 1) }).mode).toBe('HITL');
  });

  it('G7 needs two approvals for a dual-approval change flag, or at Critical risk', () => {
    expect(resolve('G7', 'low').approvalsNeeded).toBe(1);
    expect(resolve('G7', 'low', { changeFlags: ['personal_data'] }).approvalsNeeded).toBe(2);
    expect(resolve('G7', 'critical').approvalsNeeded).toBe(2);
  });

  it('G8 is a production release: HITL at every tier', () => {
    for (const risk of ['low', 'medium', 'high'] as const) {
      expect(resolve('G8', risk).mode).toBe('HITL');
    }
  });
});

describe('the workflow resolves oversight through the shared function', () => {
  const steps = ['step.ts', 'g4.ts', 'g5.ts', 'g6-verify.ts', 'g7.ts', 'g8.ts'];
  for (const file of steps) {
    it(`${file} never calls oversightMode itself`, () => {
      const file_ = path.join(repoRoot(), 'platform/packages/core/src/workflow', file);
      expect(readFileSync(file_, 'utf8')).not.toMatch(/\.oversightMode\(/);
    });
  }
});
