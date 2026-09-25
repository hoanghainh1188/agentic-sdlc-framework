// Working-time calendar for SLA and gate clocks (handbook Ch.6 §6.4, codes table §6.3).
// Wall-clock units (minutes, hours, days) run all the time. Working units run only inside the
// working hours of working days, in the calendar's time zone, and skip `holidays`.
// One working day = the length of the working hours (09:00–18:00 = 540 working minutes).
import type { Deadline, Duration, Weekday, WorkingCalendar } from '@sdlc/contracts';
import type { MessageKey } from '@sdlc/messages';

const MINUTE_MS = 60_000;
const WALL_MINUTES = { minutes: 1, hours: 60, days: 1440 } as const;
const WEEKDAYS: readonly Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
/** Search limit for the next working time: about 10 years of local days. */
const MAX_DAYS_SEARCHED = 3660;

/** Thrown when the calendar has no working time left (for example every day is a holiday). */
export class NoWorkingTimeError extends Error {
  readonly key: MessageKey = 'config.calendar.no_working_time';

  constructor() {
    super('config.calendar.no_working_time');
    this.name = 'NoWorkingTimeError';
  }
}

interface LocalDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** Minutes after midnight for `HH:MM`. */
export function minutesOfDay(hhmm: string): number {
  const [hours = 0, minutes = 0] = hhmm.split(':').map(Number);
  return hours * 60 + minutes;
}

/** Length of one working day in minutes. */
export function workingDayMinutes(calendar: WorkingCalendar): number {
  return minutesOfDay(calendar.working_hours.end) - minutesOfDay(calendar.working_hours.start);
}

/** True for durations counted in working time. */
export function isWorkingUnit(unit: Duration['unit']): boolean {
  return unit === 'working_hours' || unit === 'working_days';
}

/** A duration in minutes: wall minutes for wall units, working minutes for working units. */
export function durationMinutes(duration: Duration, calendar: WorkingCalendar): number {
  switch (duration.unit) {
    case 'working_hours':
      return duration.value * 60;
    case 'working_days':
      return duration.value * workingDayMinutes(calendar);
    default:
      return duration.value * WALL_MINUTES[duration.unit];
  }
}

/**
 * When a clock that starts at `start` runs out. Returns null for "next planned work" (no clock).
 */
export function deadlineFrom(
  start: Date,
  deadline: Deadline,
  calendar: WorkingCalendar,
): Date | null {
  if ('kind' in deadline) {
    return deadline.kind === 'end_of_working_day' ? endOfWorkingDay(start, calendar) : null;
  }
  const minutes = durationMinutes(deadline, calendar);
  return isWorkingUnit(deadline.unit)
    ? addWorkingMinutes(start, minutes, calendar)
    : new Date(start.getTime() + minutes * MINUTE_MS);
}

/** Adds working minutes to `start`, skipping non-working time. */
export function addWorkingMinutes(start: Date, minutes: number, calendar: WorkingCalendar): Date {
  let remaining = minutes;
  for (const { open, close } of workingIntervals(start, calendar)) {
    const from = Math.max(open, start.getTime());
    if (from >= close) continue;
    const available = (close - from) / MINUTE_MS;
    if (remaining <= available) return new Date(from + remaining * MINUTE_MS);
    remaining -= available;
  }
  throw new NoWorkingTimeError();
}

/** The end of the working day that `start` falls in, or of the next working day. */
export function endOfWorkingDay(start: Date, calendar: WorkingCalendar): Date {
  for (const { close } of workingIntervals(start, calendar)) {
    if (close > start.getTime()) return new Date(close);
  }
  throw new NoWorkingTimeError();
}

/** Working intervals (epoch ms) from the local day of `start` onwards. */
function* workingIntervals(
  start: Date,
  calendar: WorkingCalendar,
): Generator<{ open: number; close: number }> {
  const first = localDateOf(start, calendar.time_zone);
  const holidays = new Set(calendar.holidays);
  const openAt = minutesOfDay(calendar.working_hours.start);
  const closeAt = minutesOfDay(calendar.working_hours.end);
  for (let offset = 0; offset < MAX_DAYS_SEARCHED; offset += 1) {
    const date = addDays(first, offset);
    if (!isWorkingDate(date, calendar, holidays)) continue;
    yield {
      open: zonedToEpoch(date, openAt, calendar.time_zone),
      close: zonedToEpoch(date, closeAt, calendar.time_zone),
    };
  }
}

function isWorkingDate(date: LocalDate, calendar: WorkingCalendar, holidays: Set<string>): boolean {
  const weekday = WEEKDAYS[new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()];
  return (
    weekday !== undefined && calendar.working_days.includes(weekday) && !holidays.has(isoDate(date))
  );
}

function isoDate({ year, month, day }: LocalDate): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function addDays(date: LocalDate, days: number): LocalDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Local wall-clock fields of an instant, as UTC epoch ms (seconds included). */
function localFieldsAsUtc(epochMs: number, timeZone: string): number {
  const parts = Object.fromEntries(
    formatterFor(timeZone)
      .formatToParts(new Date(epochMs))
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<string, number>;
  return Date.UTC(
    parts.year ?? 0,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
  );
}

function localDateOf(instant: Date, timeZone: string): LocalDate {
  const local = new Date(localFieldsAsUtc(instant.getTime(), timeZone));
  return { year: local.getUTCFullYear(), month: local.getUTCMonth() + 1, day: local.getUTCDate() };
}

/** Epoch ms of a local date and time in a time zone (handles offset changes such as DST). */
function zonedToEpoch(date: LocalDate, minuteOfDay: number, timeZone: string): number {
  const asUtc = Date.UTC(date.year, date.month - 1, date.day, 0, minuteOfDay);
  const offset = (instant: number) => localFieldsAsUtc(instant, timeZone) - instant;
  const firstGuess = asUtc - offset(asUtc);
  const secondOffset = offset(firstGuess);
  return asUtc - secondOffset;
}
