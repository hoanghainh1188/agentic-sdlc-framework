// Time arithmetic for the screens. Pure: every function takes `now`, so tests pin the clock.

/** Whole seconds from `fromIso` to `now`; null when there is no time. Never negative. */
export function secondsSince(fromIso: string | null, now: Date): number | null {
  if (fromIso === null) return null;
  const from = Date.parse(fromIso);
  if (Number.isNaN(from)) return null;
  return Math.max(0, Math.floor((now.getTime() - from) / 1000));
}

export interface DurationParts {
  readonly days: number;
  readonly hours: number;
  readonly minutes: number;
}

export function durationParts(seconds: number): DurationParts {
  const total = Math.max(0, Math.floor(seconds));
  return {
    days: Math.floor(total / 86_400),
    hours: Math.floor((total % 86_400) / 3_600),
    minutes: Math.floor((total % 3_600) / 60),
  };
}

/** The catalog key and parameters of a short duration: `3d 4h`, `5h 12m`, `7m`, `< 1m`. */
export function durationLabel(seconds: number): {
  readonly key: string;
  readonly params: Readonly<Record<string, number>>;
} {
  const { days, hours, minutes } = durationParts(seconds);
  if (days > 0) return { key: 'dashboard.duration.days_hours', params: { days, hours } };
  if (hours > 0) return { key: 'dashboard.duration.hours_minutes', params: { hours, minutes } };
  if (minutes > 0) return { key: 'dashboard.duration.minutes', params: { minutes } };
  return { key: 'dashboard.duration.under_minute', params: {} };
}

/**
 * A due time against `now`: past due, due within the hour (`soon`, a display rule only), or later.
 * `none` when the escalation has no such clock (for example "next planned work").
 */
export type DueState = 'overdue' | 'soon' | 'later' | 'none';

export const SOON_SECONDS = 3_600;

export function dueState(dueIso: string | null, now: Date): { state: DueState; seconds: number } {
  if (dueIso === null) return { state: 'none', seconds: 0 };
  const due = Date.parse(dueIso);
  if (Number.isNaN(due)) return { state: 'none', seconds: 0 };
  const seconds = Math.floor((due - now.getTime()) / 1000);
  if (seconds < 0) return { state: 'overdue', seconds: -seconds };
  return { state: seconds <= SOON_SECONDS ? 'soon' : 'later', seconds };
}
