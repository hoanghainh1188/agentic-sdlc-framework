// B07 session 2 (ADR-M30 §2.4b, §2.9): the pure parts of the HOTL block window and the gate
// deadline, on the working calendar of the configuration. The database side: integration/db.
import { loadProjectConfig } from '@sdlc/config';
import { describe, expect, it } from 'vitest';

import { waitedSeconds } from '../../packages/core/src/workflow/step.js';
import { blockWindowEnd, gateBefore } from '../../packages/core/src/workflow/hotl.js';
import {
  gateClockStart,
  gateDeadline,
  overdueRoute,
} from '../../packages/core/src/workflow/overdue.js';
import { MIN_TIMER_MS } from '../../apps/worker/src/workflows/intent-workflow.js';

const loaded = loadProjectConfig('');
if (!loaded.ok) throw new Error('defaults must load');
const config = loaded.config;

describe('HOTL block window (QUESTIONS #88)', () => {
  it('counts oversight.hotl_block_window in working hours of the calendar', () => {
    // Friday 16:00 in Ho Chi Minh City + 4 working hours = Monday 11:00 local.
    expect(blockWindowEnd(new Date('2026-10-02T09:00:00Z'), config)).toEqual(
      new Date('2026-10-05T04:00:00Z'),
    );
  });

  it('orders gates', () => {
    expect(gateBefore('G2', 'G4')).toBe(true);
    expect(gateBefore('G3', 'G3')).toBe(false);
    expect(gateBefore('G4', 'G2')).toBe(false);
  });
});

describe('gate deadline (QUESTIONS #90, D4)', () => {
  const entered = new Date('2026-09-28T03:00:00Z'); // Monday 10:00 local

  it('is hitl_gate_deadline (1 working day) after the clock start', () => {
    expect(gateDeadline(entered, config)).toEqual(new Date('2026-09-29T03:00:00Z'));
  });

  it('starts at the entry, or at a later request for changes', () => {
    const intent = { gate_entered_at: entered, updated_at: entered };
    expect(gateClockStart(intent, null)).toEqual(entered);
    const later = new Date('2026-09-28T05:00:00Z');
    expect(gateClockStart(intent, later)).toEqual(later);
    // A request for changes from before this entry does not move the clock back.
    expect(gateClockStart(intent, new Date('2026-09-27T05:00:00Z'))).toEqual(entered);
  });

  it('routes to intent when Person A holds the gate role, otherwise technical', () => {
    expect(overdueRoute({ roles: ['person_a'] })).toBe('intent');
    expect(overdueRoute({ roles: ['person_b', 'second_approver'] })).toBe('technical');
    expect(overdueRoute({ roles: [] })).toBe('technical');
  });
});

describe('waited_seconds (FR-12)', () => {
  it('counts wall-clock seconds since the gate entry', () => {
    const intent = { gate_entered_at: new Date('2026-09-28T01:00:00Z') };
    expect(waitedSeconds(intent, new Date('2026-09-28T01:01:30.900Z'))).toBe(90);
    expect(waitedSeconds(intent, new Date('2026-09-28T00:59:00Z'))).toBe(0);
    expect(waitedSeconds({ gate_entered_at: null }, new Date())).toBeNull();
  });

  it('the workflow never sets a timer shorter than one second', () => {
    expect(MIN_TIMER_MS).toBe(1000);
  });
});
