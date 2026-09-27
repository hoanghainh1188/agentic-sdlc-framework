// D-08 B11 AC3: the acknowledge and resolve clocks from the SLA table and the working calendar,
// and the chain reminder → backup → governance (handbook Ch.6 §6.4–§6.5, QUESTIONS #73, #75,
// design/ADR-M28 §2.2). Pure functions with fixed times; the database part is in
// tests/integration/db/escalations.test.ts.
import type { ValidatedProjectConfig, Severity } from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

import {
  advanceClock,
  initialClocks,
  nextCheckAt,
  type ClockEffect,
  type ClockState,
} from '../../packages/core/src/escalation/clock.js';
import { loadValid } from '../config/helpers';

const settings = (yaml = ''): ValidatedProjectConfig['escalation'] =>
  (loadValid(yaml).config as ValidatedProjectConfig).escalation;

const DEFAULTS = settings();
/** The default calendar is Asia/Ho_Chi_Minh (UTC+7), Monday–Friday 09:00–18:00. */
const at = (iso: string): Date => new Date(iso);

function newState(
  createdAt: Date,
  severity: Severity,
  config = DEFAULTS,
  backupOwnerId: string | null = 'backup-user',
): ClockState {
  const clocks = initialClocks(createdAt, severity, config);
  return {
    severity,
    status: 'open',
    currentStep: 'owner',
    backupOwnerId,
    stepDueAt: clocks.dueAt,
    remindAt: clocks.remindAt,
    remindedStep: null,
    ackMissedAt: null,
    governanceOverdueAt: null,
    resolveDueAt: clocks.resolveDueAt,
    resolveOverdueAt: null,
  };
}

const summary = (effects: readonly ClockEffect[]) =>
  effects.map((e) => {
    const time = e.at.toISOString().slice(11, 16);
    switch (e.kind) {
      case 'reminded':
        return `${time} remind ${e.step}`;
      case 'step_changed':
        return `${time} ${e.from}→${e.to}`;
      case 'governance_overdue':
        return `${time} governance overdue`;
      case 'resolve_overdue':
        return `${time} resolve overdue from ${e.from}${e.incident ? ' (incident)' : ''}`;
    }
  });

describe('initial clocks (codes table §6.3, Ch.6 §6.4)', () => {
  it('Critical: acknowledge 15 min, reminder at 75 %, resolve 1 h, wall clock', () => {
    const created = at('2026-09-28T03:00:00Z'); // Monday 10:00 local
    const clocks = initialClocks(created, 'critical', DEFAULTS);
    expect(clocks.dueAt.toISOString()).toBe('2026-09-28T03:15:00.000Z');
    expect(clocks.remindAt?.toISOString()).toBe('2026-09-28T03:11:00.000Z');
    expect(clocks.resolveDueAt?.toISOString()).toBe('2026-09-28T04:00:00.000Z');
  });

  it('High: resolve at the end of the working day', () => {
    const clocks = initialClocks(at('2026-09-28T03:00:00Z'), 'high', DEFAULTS);
    expect(clocks.dueAt.toISOString()).toBe('2026-09-28T04:00:00.000Z');
    expect(clocks.resolveDueAt?.toISOString()).toBe('2026-09-28T11:00:00.000Z'); // 18:00 local
  });

  it('Medium: working days skip the weekend', () => {
    // Friday 17:00 local: 1 working day = 540 working minutes → Monday 17:00 local.
    const clocks = initialClocks(at('2026-10-02T10:00:00Z'), 'medium', DEFAULTS);
    expect(clocks.dueAt.toISOString()).toBe('2026-10-05T10:00:00.000Z');
    // 75 % = 405 working minutes → Monday 14:45 local.
    expect(clocks.remindAt?.toISOString()).toBe('2026-10-05T07:45:00.000Z');
    // 3 working days → Wednesday 17:00 local.
    expect(clocks.resolveDueAt?.toISOString()).toBe('2026-10-07T10:00:00.000Z');
  });

  it('Medium: holidays of the calendar are skipped', () => {
    const withHoliday = settings('escalation:\n  calendar:\n    holidays: [2026-10-05]\n');
    const clocks = initialClocks(at('2026-10-02T10:00:00Z'), 'medium', withHoliday);
    expect(clocks.dueAt.toISOString()).toBe('2026-10-06T10:00:00.000Z'); // Tuesday 17:00 local
  });

  it('Low: "next planned work" has no resolve clock', () => {
    const state = newState(at('2026-09-28T03:00:00Z'), 'low');
    expect(state.resolveDueAt).toBeNull();
    expect(nextCheckAt(state)).toEqual(state.remindAt);
  });

  it('the reminder share comes from the configuration', () => {
    const early = settings('escalation:\n  reminder_percent: 50\n');
    const clocks = initialClocks(at('2026-09-28T03:00:00Z'), 'critical', early);
    expect(clocks.remindAt?.toISOString()).toBe('2026-09-28T03:07:00.000Z'); // floor(7.5 min)
  });
});

describe('the chain owner → backup → governance (Ch.6 §6.5)', () => {
  const created = at('2026-09-28T03:00:00Z');

  it('nothing happens before the reminder', () => {
    const state = newState(created, 'critical');
    const result = advanceClock(state, at('2026-09-28T03:10:59Z'), DEFAULTS);
    expect(result.effects).toEqual([]);
    expect(result.state).toEqual(state);
  });

  it('runs every step in order; each step gets a fresh window from the SLA table', () => {
    let state = newState(created, 'critical');
    const seen: string[] = [];
    for (const minute of ['03:11', '03:15', '03:26', '03:30', '03:41', '03:45', '04:00']) {
      const result = advanceClock(state, at(`2026-09-28T${minute}:00Z`), DEFAULTS);
      state = result.state;
      seen.push(...summary(result.effects));
    }
    expect(seen).toEqual([
      '03:11 remind owner',
      '03:15 owner→backup',
      '03:26 remind backup',
      '03:30 backup→governance',
      '03:41 remind governance',
      '03:45 governance overdue',
      '04:00 resolve overdue from governance (incident)',
    ]);
    expect(state.ackMissedAt?.toISOString()).toBe('2026-09-28T03:15:00.000Z');
    expect(nextCheckAt(state)).toBeNull();
  });

  it('a late check catches up in the same order, and a second run changes nothing', () => {
    const late = at('2026-09-28T09:00:00Z');
    const first = advanceClock(newState(created, 'critical'), late, DEFAULTS);
    expect(summary(first.effects)).toEqual([
      '03:11 remind owner',
      '03:15 owner→backup',
      '03:26 remind backup',
      '03:30 backup→governance',
      '03:41 remind governance',
      '03:45 governance overdue',
      '04:00 resolve overdue from governance (incident)',
    ]);
    const again = advanceClock(first.state, late, DEFAULTS);
    expect(again.effects).toEqual([]);
    expect(again.state).toEqual(first.state);
  });

  it('skips the backup step when the backup role has no holder', () => {
    const result = advanceClock(
      newState(created, 'critical', DEFAULTS, null),
      at('2026-09-28T03:15:00Z'),
      DEFAULTS,
    );
    expect(summary(result.effects)).toEqual(['03:11 remind owner', '03:15 owner→governance']);
  });

  it('an acknowledged escalation runs only the resolve clock; governance takes over', () => {
    const state: ClockState = { ...newState(created, 'high'), status: 'acknowledged' };
    expect(nextCheckAt(state)?.toISOString()).toBe('2026-09-28T11:00:00.000Z');
    const result = advanceClock(state, at('2026-09-28T12:00:00Z'), DEFAULTS);
    expect(summary(result.effects)).toEqual(['11:00 resolve overdue from owner']);
    expect(result.state.currentStep).toBe('governance');
    expect(result.state.stepDueAt).toEqual(state.stepDueAt);
    expect(nextCheckAt(result.state)).toBeNull();
  });

  it('an open escalation past its resolve deadline moves to governance with a fresh window', () => {
    // Medium: owner window 1 working day, resolve 3 working days; nobody at owner answers on time
    // but the backup step is not reached because the resolve clock is checked on its own.
    const state: ClockState = {
      ...newState(at('2026-10-02T10:00:00Z'), 'medium'),
      currentStep: 'backup',
      remindedStep: 'backup',
      stepDueAt: at('2026-10-09T10:00:00Z'),
    };
    const result = advanceClock(state, at('2026-10-07T10:00:00Z'), DEFAULTS);
    expect(summary(result.effects)).toEqual(['10:00 resolve overdue from backup']);
    expect(result.state.currentStep).toBe('governance');
    expect(result.state.stepDueAt.toISOString()).toBe('2026-10-08T10:00:00.000Z');
  });

  it('resolved and closed escalations have no pending clock', () => {
    const state = newState(created, 'critical');
    expect(nextCheckAt({ ...state, status: 'resolved' })).toBeNull();
    expect(nextCheckAt({ ...state, status: 'closed' })).toBeNull();
  });
});
