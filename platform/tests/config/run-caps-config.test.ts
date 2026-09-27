// Run caps (D-02 FR-32, handbook template T13, QUESTIONS.md #13, D-08 C05): the default iteration
// and time caps of a run come from configuration, not from code. Raising them warns (ADR-M13).
import { formatIssue } from '@sdlc/config';
import { describe, expect, it } from 'vitest';

import { keysAndPaths, loadErrors, loadValid } from './helpers';

const run = (lines: string) => `run:\n${lines}`;

describe('run.default_max_iterations and run.default_max_duration_minutes', () => {
  it('default to template T13: 30 iterations, 60 minutes', () => {
    const { config, warnings } = loadValid();
    expect(config.run.default_max_iterations).toBe(30);
    expect(config.run.default_max_duration_minutes).toBe(60);
    expect(warnings).toEqual([]);
  });

  it('accept lower caps without a warning', () => {
    const lower = run('  default_max_iterations: 10\n  default_max_duration_minutes: 15\n');
    expect(loadValid(lower).warnings).toEqual([]);
  });

  it('warn when a cap is raised above the default', () => {
    const { warnings } = loadValid(
      run('  default_max_iterations: 50\n  default_max_duration_minutes: 90\n'),
    );
    expect(keysAndPaths(warnings)).toEqual([
      ['config.warning.run_cap_raised', 'run.default_max_iterations'],
      ['config.warning.run_cap_raised', 'run.default_max_duration_minutes'],
    ]);
    expect(formatIssue(warnings[0]!)).toBe(
      'run.default_max_iterations: the run cap is raised from 30 to 50 (template T13). This change must be reviewed.',
    );
  });

  it.each(['0', '-1', '2.5', '"30"'])('refuse %s', (value) => {
    expect(keysAndPaths(loadErrors(run(`  default_max_iterations: ${value}\n`)))[0]?.[1]).toBe(
      'run.default_max_iterations',
    );
    expect(
      keysAndPaths(loadErrors(run(`  default_max_duration_minutes: ${value}\n`)))[0]?.[1],
    ).toBe('run.default_max_duration_minutes');
  });
});
