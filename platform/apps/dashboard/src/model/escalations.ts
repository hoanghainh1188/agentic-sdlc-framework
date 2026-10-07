// Open escalations (U01 AC4): the clock that matters now, nearest first.
import type { EscalationView } from '@sdlc/api-schemas';

import { dueState, type DueState } from './time.js';

export interface EscalationRow {
  readonly escalation: EscalationView;
  /** Acknowledge clock until acknowledged, then the resolve clock. */
  readonly clock: 'acknowledge' | 'resolve';
  readonly due: string | null;
  readonly state: DueState;
  readonly seconds: number;
}

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];

export function escalationRows(
  escalations: readonly EscalationView[],
  now: Date,
): readonly EscalationRow[] {
  return escalations
    .filter((e) => e.status === 'open' || e.status === 'acknowledged')
    .map((escalation): EscalationRow => {
      const clock = escalation.status === 'open' ? 'acknowledge' : 'resolve';
      const due =
        clock === 'acknowledge'
          ? (escalation.step_due_at ?? escalation.ack_due_at)
          : escalation.resolve_due_at;
      return { escalation, clock, due, ...dueState(due, now) };
    })
    .sort(compareRows);
}

function urgency(row: EscalationRow): number {
  // Overdue first (the longest overdue first), then the nearest due, then no clock.
  if (row.state === 'overdue') return -1e12 - row.seconds;
  if (row.state === 'none') return 1e12;
  return row.seconds;
}

function compareRows(a: EscalationRow, b: EscalationRow): number {
  return (
    urgency(a) - urgency(b) ||
    SEVERITY_ORDER.indexOf(a.escalation.severity) - SEVERITY_ORDER.indexOf(b.escalation.severity) ||
    a.escalation.code.localeCompare(b.escalation.code)
  );
}
