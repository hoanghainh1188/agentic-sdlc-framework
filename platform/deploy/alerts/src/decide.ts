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

function parts(key: string): { id: string; subject: string } {
  const at = key.indexOf('|');
  return { id: key.slice(0, at), subject: key.slice(at + 1) };
}

function due(sent: SentAlert, now: Date, remindHours: number): boolean {
  return now.getTime() - Date.parse(sent.sentAt) >= remindHours * HOUR_MS;
}

/** The resolved line of a remembered problem: its own ok line, or a generic one for its subject. */
function resolvedLine(key: string, byKey: ReadonlyMap<string, CheckResult>): CheckResult {
  const own = byKey.get(key);
  if (own?.status === 'ok') return own;
  const { id, subject } = parts(key);
  return {
    id: id as CheckResult['id'],
    ...(subject ? { subject } : {}),
    status: 'ok',
    text: { key: 'alerts.resolved_line' },
  };
}

/**
 * A problem is sent when it is new or its status changed, and again after `remindHours`. A
 * remembered problem is resolved when its check gave lines this run that are not skipped and it is
 * not among the problems; this also covers checks whose ok line has no subject (one line per
 * unhealthy service, one ok line for all). A check whose lines are all skipped (a stopped stack, a
 * sealed OpenBao) keeps every subject it had: it proves nothing. A check gone from the results is
 * forgotten without a message.
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
  const byKey = new Map(results.map((r) => [keyOf(r), r]));
  const seen = new Set(results.map((r) => r.id as string));
  const decided = new Set(results.filter((r) => r.status !== 'skipped').map((r) => r.id as string));

  for (const result of results) {
    if (result.status !== 'warning' && result.status !== 'failed') continue;
    const key = keyOf(result);
    const before = prev[key];
    if (!before || before.status !== result.status) {
      items.push({ kind: 'problem', result });
      next[key] = { status: result.status, sentAt };
    } else if (due(before, now, remindHours)) {
      items.push({ kind: 'reminder', result });
      next[key] = { status: result.status, sentAt };
    } else {
      next[key] = before;
    }
  }
  for (const [key, before] of Object.entries(prev)) {
    if (next[key]) continue;
    const { id } = parts(key);
    if (byKey.get(key)?.status === 'skipped' || (seen.has(id) && !decided.has(id))) {
      next[key] = before;
    } else if (decided.has(id)) {
      items.push({ kind: 'resolved', result: resolvedLine(key, byKey) });
    }
  }
  return { items, next };
}
