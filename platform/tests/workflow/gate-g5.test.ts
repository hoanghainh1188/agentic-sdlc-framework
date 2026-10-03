// C07 PR 2 (ADR-M34 §2.8): the order of the G5 checks and the share of the cap spent, without a
// database. Behaviour on PostgreSQL: tests/integration/db/gate-g5.test.ts.
import { loadProjectConfig } from '@sdlc/config';
import type { RunStatus, ValidatedProjectConfig } from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

import type { Run } from '../../packages/core/src/db/schema.js';
import { spentPercent, type G5Facts } from '../../packages/core/src/workflow/g5-facts.js';
import { g5Breach } from '../../packages/core/src/workflow/g5.js';

const loaded = loadProjectConfig('');
if (!loaded.ok) throw new Error('default configuration refused');
const CONFIG: ValidatedProjectConfig = loaded.config;

function facts(
  status: RunStatus,
  stopReason: string | null,
  changes: { out?: number; instructions?: number } | null = {},
  spentUsd = '0',
): G5Facts {
  return {
    run: { status, stop_reason: stopReason } as Run,
    diffSha256: 'd'.repeat(64),
    changes:
      changes === null
        ? null
        : {
            changedFiles: 3,
            outOfScope: changes.out ?? 0,
            instructionFiles: changes.instructions ?? 0,
            pathsSha256: 'a'.repeat(64),
          },
    keyCapUsd: '2',
    spentUsd,
    intentSpentUsd: spentUsd,
    inputSha256: 'f'.repeat(64),
  };
}

const check = (f: G5Facts) => {
  const breach = g5Breach(f, CONFIG);
  return breach && [breach.reason, breach.check, breach.escalation?.route ?? null];
};

describe('g5Breach: instruction files, then scope, then caps', () => {
  it('passes a succeeded run in scope within its cap', () => {
    expect(check(facts('succeeded', null))).toBeNull();
  });

  it('instruction files come first, even with files out of scope and a budget stop', () => {
    expect(check(facts('stopped_budget', 'max_budget', { out: 2, instructions: 1 }))).toEqual([
      'instructions_unpinned',
      'instructions_changed',
      'security',
    ]);
  });

  it('scope comes before the caps; it never escalates (back to G3)', () => {
    expect(check(facts('stopped_budget', 'max_budget', { out: 1 }))).toEqual([
      'out_of_scope',
      'out_of_scope',
      null,
    ]);
    expect(check(facts('stopped_scope', 'out_of_scope'))).toEqual([
      'out_of_scope',
      'out_of_scope',
      null,
    ]);
  });

  it('the cost cap is budget_exceeded; the other caps are run_cap_reached, never budget_exceeded', () => {
    expect(check(facts('stopped_budget', 'max_budget'))).toEqual([
      'budget_exceeded',
      'max_budget',
      'intent',
    ]);
    expect(check(facts('stopped_budget', 'max_iterations'))).toEqual([
      'run_cap_reached',
      'max_iterations',
      'intent',
    ]);
    expect(check(facts('stopped_timeout', 'max_duration'))).toEqual([
      'run_cap_reached',
      'max_duration',
      'intent',
    ]);
    expect(check(facts('stopped_stalled', 'agent_stuck'))).toEqual([
      'run_cap_reached',
      'stalled',
      'intent',
    ]);
  });

  it('a synced spend at the stop share is a budget breach, whatever the run status', () => {
    expect(check(facts('succeeded', null, {}, '2'))).toEqual([
      'budget_exceeded',
      'spend_at_stop',
      'intent',
    ]);
    expect(check(facts('stopped_budget', 'max_iterations', {}, '2'))).toEqual([
      'budget_exceeded',
      'spend_at_stop',
      'intent',
    ]);
    expect(check(facts('succeeded', null, {}, '1.99'))).toBeNull();
  });

  it('fails closed without the runner record of the changes', () => {
    expect(check(facts('succeeded', null, null))).toEqual([
      'input_mismatch',
      'changes_missing',
      'technical',
    ]);
  });
});

describe('spentPercent', () => {
  it('whole percent of the key cap, rounded down; null without a cap', () => {
    expect(spentPercent({ keyCapUsd: '2', spentUsd: '1.7' })).toBe(85);
    expect(spentPercent({ keyCapUsd: '3', spentUsd: '1' })).toBe(33);
    expect(spentPercent({ keyCapUsd: null, spentUsd: '1' })).toBeNull();
    expect(spentPercent({ keyCapUsd: '0', spentUsd: '1' })).toBeNull();
  });
});
