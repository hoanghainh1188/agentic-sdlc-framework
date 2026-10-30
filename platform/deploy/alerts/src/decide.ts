// When `pnpm alerts` sends a doctor result (D-08 O03, design/ADR-M101). Pure: the state of the last
// run and this run's results in, the items to send and the next state out.
import type { CheckResult } from '../../doctor/dist/types.js';

export type AlertKind = 'problem' | 'reminder' | 'resolved';

export interface AlertItem {
  readonly kind: AlertKind;
  readonly result: CheckResult;
}

/** What was last sent for one check and subject: its status and when. */
export interface SentAlert {
  readonly status: 'warning' | 'failed';
  readonly sentAt: string;
}

export type AlertState = Readonly<Record<string, SentAlert>>;

const HOUR_MS = 3_600_000;

/** One line of doctor: a check, and its subject when the check gives several lines. */
export function keyOf(r: CheckResult): string {
  return `${r.id}|${r.subject ?? ''}`;
}

function due(sent: SentAlert, now: Date, remindHours: number): boolean {
  return now.getTime() - Date.parse(sent.sentAt) >= remindHours * HOUR_MS;
}

/**
 * A problem is sent when it is new or its status changed, and again after `remindHours`; an ok
 * check that was a problem is sent as resolved. A skipped check keeps what was known (a stopped
 * stack proves nothing); a problem whose line is gone is forgotten without a message.
 */
export function decide(
  prev: AlertState,
  results: readonly CheckResult[],
  now: Date,
  remindHours: number,
): { items: AlertItem[]; next: AlertState } {
  const items: AlertItem[] = [];
  const next: Record<string, SentAlert> = {};
  const sentAt = now.toISOString();
  for (const result of results) {
    const key = keyOf(result);
    const before = prev[key];
    if (result.status === 'skipped') {
      if (before) next[key] = before;
    } else if (result.status === 'ok') {
      if (before) items.push({ kind: 'resolved', result });
    } else if (!before || before.status !== result.status) {
      items.push({ kind: 'problem', result });
      next[key] = { status: result.status, sentAt };
    } else if (due(before, now, remindHours)) {
      items.push({ kind: 'reminder', result });
      next[key] = { status: result.status, sentAt };
    } else {
      next[key] = before;
    }
  }
  return { items, next };
}
