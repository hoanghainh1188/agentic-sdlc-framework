// Task L09 AC2 (ADR-M86 §2.4, QUESTIONS #496–#499): `agents.evaluation` holds what an evaluation
// must reach before an agent version is approved. Default mode `warn`; rule M34 keeps the
// recertification age at 90 days or less (tested with the other rules in mandatory-rules.test.ts).
import { describe, expect, it } from 'vitest';

import { loadErrors, loadValid } from './helpers';

const evaluation = (body: string) => `agents:\n  evaluation:\n${body}`;

describe('agents.evaluation (L09 AC2)', () => {
  it('defaults: warn, 8 tasks, a resolve rate of 0.5, 30 and 90 days', () => {
    expect(loadValid().config.agents.evaluation).toEqual({
      mode: 'warn',
      min_tasks: 8,
      min_resolve_rate: 0.5,
      approval_max_age_days: 30,
      recertification_max_age_days: 90,
    });
  });

  it.each(['off', 'warn', 'required'])('accepts the mode %s', (mode) => {
    expect(loadValid(evaluation(`    mode: ${mode}\n`)).config.agents.evaluation.mode).toBe(mode);
  });

  it('accepts a project’s own thresholds, with 0 and 1 as resolve rates', () => {
    for (const rate of [0, 1]) {
      const { config } = loadValid(
        evaluation(
          `    min_tasks: 1\n    min_resolve_rate: ${rate}\n    approval_max_age_days: 7\n`,
        ),
      );
      expect(config.agents.evaluation).toMatchObject({
        min_tasks: 1,
        min_resolve_rate: rate,
        approval_max_age_days: 7,
      });
    }
  });

  it.each([
    ['an unknown mode', '    mode: strict\n', 'agents.evaluation.mode'],
    ['no task', '    min_tasks: 0\n', 'agents.evaluation.min_tasks'],
    [
      'a resolve rate below 0',
      '    min_resolve_rate: -0.1\n',
      'agents.evaluation.min_resolve_rate',
    ],
    ['a resolve rate above 1', '    min_resolve_rate: 1.5\n', 'agents.evaluation.min_resolve_rate'],
    [
      'an age of 0 days',
      '    approval_max_age_days: 0\n',
      'agents.evaluation.approval_max_age_days',
    ],
    ['an unknown key', '    alpha: 0.05\n', 'agents.evaluation'],
  ])('refuses %s', (_name, body, path) => {
    expect(loadErrors(evaluation(body)).map((e) => e.path)).toContain(path);
  });

  it('accepts 90 days for a recertification and refuses 91 (rule M34)', () => {
    expect(
      loadValid(evaluation('    recertification_max_age_days: 90\n')).config.agents.evaluation
        .recertification_max_age_days,
    ).toBe(90);
    expect(loadErrors(evaluation('    recertification_max_age_days: 91\n'))).toEqual([
      expect.objectContaining({
        key: 'config.rule.recertification_evaluation_max_age',
        path: 'agents.evaluation.recertification_max_age_days',
      }),
    ]);
  });
});
