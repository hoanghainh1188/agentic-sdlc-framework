// Overdue gates (D-02 FR-12, FR-18; QUESTIONS.md #90; D-08 B07 AC4): severity and response level of
// the escalation raised at `oversight.hitl_gate_deadline` come from configuration, not from code.
import { describe, expect, it } from 'vitest';

import { keysAndPaths, loadErrors, loadValid } from './helpers';

const overdue = (value: string) => `oversight:\n  gate_overdue: ${value}\n`;

describe('oversight.gate_overdue', () => {
  it('defaults to the [Proposal] pilot values: medium, notify', () => {
    expect(loadValid().config.oversight.gate_overdue).toEqual({
      severity: 'medium',
      response_level: 'notify',
    });
  });

  it('accepts another severity and a freezing level', () => {
    const { config } = loadValid(overdue('{ severity: high, response_level: pause }'));
    expect(config.oversight.gate_overdue).toEqual({ severity: 'high', response_level: 'pause' });
  });

  it.each([
    ['{ severity: urgent, response_level: notify }', 'oversight.gate_overdue.severity'],
    ['{ severity: low, response_level: shout }', 'oversight.gate_overdue.response_level'],
  ])('refuses %s', (value, path) => {
    expect(keysAndPaths(loadErrors(overdue(value)))[0]?.[1]).toBe(path);
  });

  it('refuses unknown keys', () => {
    expect(
      keysAndPaths(loadErrors(overdue('{ severity: low, response_level: notify, route: intent }'))),
    ).toEqual([['config.schema.unknown_key', 'oversight.gate_overdue']]);
  });
});
