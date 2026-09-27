// D-08 B11: the escalation settings of the project configuration (routing, notify on raise,
// reminder share, safe list; QUESTIONS #74–#76, design/ADR-M28 §2.6). Rule M17 cases are in
// mandatory-rules.test.ts.
import { describe, expect, it } from 'vitest';

import { keysAndPaths, loadErrors, loadValid } from './helpers';

describe('escalation settings', () => {
  it('has the handbook defaults', () => {
    const { escalation } = loadValid().config;
    expect(escalation.routing).toEqual({
      intent: { owner_role: 'person_a', backup_role: 'person_b' },
      technical: { owner_role: 'person_b', backup_role: 'second_approver' },
      security: { owner_role: 'person_b', backup_role: 'second_approver' },
      policy: { owner_role: 'governance', backup_role: null },
    });
    expect(escalation.notify_on_raise.critical).toContain('governance');
    expect(escalation.reminder_percent).toBe(75);
    expect(escalation.safe_actions).toEqual([
      'read_only',
      'sandbox_test',
      'unpublished_draft',
      'collect_metrics',
    ]);
  });

  it('a project may shorten the safe list and add roles to notify', () => {
    const { escalation } = loadValid(
      'escalation:\n  safe_actions: [read_only]\n  notify_on_raise:\n    low: [person_a, pm_brse]\n',
    ).config;
    expect(escalation.safe_actions).toEqual(['read_only']);
    expect(escalation.notify_on_raise.low).toEqual(['person_a', 'pm_brse']);
  });

  it('refuses a risky action on the safe list (only the handbook codes exist)', () => {
    expect(keysAndPaths(loadErrors('escalation:\n  safe_actions: [read_only, merge]\n'))).toEqual([
      ['config.schema.invalid_value', 'escalation.safe_actions[1]'],
    ]);
  });

  it.each([
    ['0', 'config.schema.too_small'],
    ['100', 'config.schema.too_big'],
  ])('refuses reminder_percent %s', (value, key) => {
    expect(keysAndPaths(loadErrors(`escalation:\n  reminder_percent: ${value}\n`))).toEqual([
      [key, 'escalation.reminder_percent'],
    ]);
  });
});
