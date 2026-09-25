// SLA and gate clocks in working time (handbook Ch.6 §6.4): working days, working hours, time zone
// and holidays (for example Tết). Default calendar: Asia/Ho_Chi_Minh (UTC+7), Mon–Fri 09:00–18:00.
import {
  addWorkingMinutes,
  deadlineFrom,
  defaultProjectConfig,
  endOfWorkingDay,
  NoWorkingTimeError,
  workingDayMinutes,
} from '@sdlc/config';
import type { WorkingCalendar } from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

import { loadValid } from './helpers';

const BASE = defaultProjectConfig().escalation.calendar;
/** Tết 2027: Lunar New Year is Saturday 2027-02-06. Holidays Fri 02-05 to Wed 02-10 (fictional). */
const TET_2027 = ['2027-02-05', '2027-02-08', '2027-02-09', '2027-02-10'];
const WITH_TET: WorkingCalendar = { ...BASE, holidays: TET_2027 };

/** An instant from a local Ho Chi Minh City time. */
const hcm = (local: string) => new Date(`${local}:00+07:00`);

describe('working calendar', () => {
  it('has 540 working minutes per day by default', () => {
    expect(workingDayMinutes(BASE)).toBe(540);
  });

  it('runs wall-clock units all the time, holidays included', () => {
    const start = hcm('2027-02-05T23:50'); // a holiday, at night
    expect(deadlineFrom(start, { value: 15, unit: 'minutes' }, WITH_TET)).toEqual(
      hcm('2027-02-06T00:05'),
    );
    expect(deadlineFrom(start, { value: 1, unit: 'hours' }, WITH_TET)).toEqual(
      hcm('2027-02-06T00:50'),
    );
    expect(deadlineFrom(start, { value: 2, unit: 'days' }, WITH_TET)).toEqual(
      hcm('2027-02-07T23:50'),
    );
  });

  it('adds working hours inside one day', () => {
    expect(addWorkingMinutes(hcm('2027-02-02T10:00'), 120, BASE)).toEqual(hcm('2027-02-02T12:00'));
  });

  it('starts counting at the next opening time when the clock starts after hours', () => {
    expect(addWorkingMinutes(hcm('2027-02-02T20:00'), 60, BASE)).toEqual(hcm('2027-02-03T10:00'));
  });

  it('skips the weekend', () => {
    const start = hcm('2027-01-29T17:00'); // Friday
    expect(deadlineFrom(start, { value: 2, unit: 'working_hours' }, BASE)).toEqual(
      hcm('2027-02-01T10:00'),
    );
  });

  it('is exact in UTC for the configured time zone', () => {
    expect(addWorkingMinutes(new Date('2027-02-02T02:00:00Z'), 60, BASE).toISOString()).toBe(
      '2027-02-02T03:00:00.000Z',
    );
  });
});

describe('SLA clocks crossing a holiday (Tết)', () => {
  it('a Medium acknowledge clock (1 working day) jumps over Tết', () => {
    // Thursday 02-04 10:00 → 8 h left that day; Fri 05 holiday, weekend, Mon–Wed holidays;
    // the last hour runs on Thursday 02-11.
    const start = hcm('2027-02-04T10:00');
    expect(deadlineFrom(start, { value: 1, unit: 'working_days' }, BASE)).toEqual(
      hcm('2027-02-05T10:00'),
    );
    expect(deadlineFrom(start, { value: 1, unit: 'working_days' }, WITH_TET)).toEqual(
      hcm('2027-02-11T10:00'),
    );
  });

  it('a working-hour clock started before the holiday ends after it', () => {
    const start = hcm('2027-02-04T16:00');
    expect(deadlineFrom(start, { value: 4, unit: 'working_hours' }, WITH_TET)).toEqual(
      hcm('2027-02-11T11:00'),
    );
  });

  it('a clock started on a holiday starts after the holiday', () => {
    const start = hcm('2027-02-08T09:30');
    expect(deadlineFrom(start, { value: 1, unit: 'working_hours' }, WITH_TET)).toEqual(
      hcm('2027-02-11T10:00'),
    );
  });

  it('a Medium resolve clock (3 working days) counts only working days', () => {
    // Thursday 02-04 (1), Tết, Thursday 02-11 (2), Friday 02-12 (3).
    const start = hcm('2027-02-04T09:00');
    expect(deadlineFrom(start, { value: 3, unit: 'working_days' }, WITH_TET)).toEqual(
      hcm('2027-02-12T18:00'),
    );
  });

  it('a High resolve clock ("same working day") on a holiday ends on the next working day', () => {
    expect(deadlineFrom(hcm('2027-02-08T11:00'), { kind: 'end_of_working_day' }, WITH_TET)).toEqual(
      hcm('2027-02-11T18:00'),
    );
    expect(endOfWorkingDay(hcm('2027-02-04T11:00'), WITH_TET)).toEqual(hcm('2027-02-04T18:00'));
    expect(endOfWorkingDay(hcm('2027-02-04T19:00'), WITH_TET)).toEqual(hcm('2027-02-11T18:00'));
  });

  it('a Low resolve clock ("next planned work") has no deadline', () => {
    expect(
      deadlineFrom(hcm('2027-02-04T11:00'), { kind: 'next_planned_work' }, WITH_TET),
    ).toBeNull();
  });

  it('uses holidays from the project configuration', () => {
    const { config } = loadValid(
      `escalation:\n  calendar:\n    holidays: [${TET_2027.join(', ')}]\n`,
    );
    const { calendar, sla } = config.escalation;
    expect(deadlineFrom(hcm('2027-02-04T10:00'), sla.medium.acknowledge, calendar)).toEqual(
      hcm('2027-02-11T10:00'),
    );
  });
});

describe('other calendars', () => {
  it('handles time zones with daylight saving time', () => {
    const berlin: WorkingCalendar = { ...BASE, time_zone: 'Europe/Berlin' };
    // DST starts on Sunday 2027-03-28; Monday opens at 09:00 CEST = 07:00 UTC.
    const start = new Date('2027-03-26T16:00:00Z'); // Friday 17:00 CET
    expect(addWorkingMinutes(start, 120, berlin).toISOString()).toBe('2027-03-29T08:00:00.000Z');
  });

  it('throws NoWorkingTimeError when no working day is left', () => {
    const noDays: WorkingCalendar = { ...BASE, working_days: ['sat'], holidays: [] };
    const allHolidays: WorkingCalendar = {
      ...noDays,
      holidays: Array.from({ length: 600 }, (_, week) =>
        new Date(Date.UTC(2027, 0, 2 + week * 7)).toISOString().slice(0, 10),
      ),
    };
    expect(() => addWorkingMinutes(new Date('2027-01-01T00:00:00Z'), 60, allHolidays)).toThrow(
      NoWorkingTimeError,
    );
    expect(addWorkingMinutes(new Date('2027-01-01T00:00:00Z'), 60, noDays)).toEqual(
      hcm('2027-01-02T10:00'),
    );
  });
});
