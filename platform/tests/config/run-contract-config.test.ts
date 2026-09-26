// Run Contract settings (QUESTIONS.md #33, ADR-M22): validity from issue to sandbox start and the
// clock skew for the "not yet valid" check. Values come from configuration, not from code.
import { formatIssue } from '@sdlc/config';
import { describe, expect, it } from 'vitest';

import { keysAndPaths, loadErrors, loadValid } from './helpers';

const run = (lines: string) => `run:\n${lines}`;

describe('run.contract_validity_minutes and run.contract_clock_skew_seconds', () => {
  it('default to 15 minutes and 0 seconds', () => {
    const { config, warnings } = loadValid();
    expect(config.run.contract_validity_minutes).toBe(15);
    expect(config.run.contract_clock_skew_seconds).toBe(0);
    expect(warnings).toEqual([]);
  });

  it('accept up to 60 minutes without a warning', () => {
    expect(loadValid(run('  contract_validity_minutes: 60\n')).warnings).toEqual([]);
  });

  it('warn above 60 minutes', () => {
    const { warnings } = loadValid(run('  contract_validity_minutes: 61\n'));
    expect(keysAndPaths(warnings)).toEqual([
      ['config.warning.contract_validity_long', 'run.contract_validity_minutes'],
    ]);
    expect(formatIssue(warnings[0]!)).toBe(
      'run.contract_validity_minutes: Run Contracts stay valid for 61 minutes (more than 60) between G4 and the sandbox start. This change must be reviewed.',
    );
  });

  it('refuse a validity of 0 and a negative or fractional skew', () => {
    expect(keysAndPaths(loadErrors(run('  contract_validity_minutes: 0\n')))[0]?.[1]).toBe(
      'run.contract_validity_minutes',
    );
    expect(keysAndPaths(loadErrors(run('  contract_clock_skew_seconds: -1\n')))[0]?.[1]).toBe(
      'run.contract_clock_skew_seconds',
    );
    expect(keysAndPaths(loadErrors(run('  contract_clock_skew_seconds: 1.5\n')))[0]?.[1]).toBe(
      'run.contract_clock_skew_seconds',
    );
  });
});
