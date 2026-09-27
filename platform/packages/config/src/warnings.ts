// Warnings for loosened, but still allowed, settings (ADR-M13: configuration changes that loosen
// control are allowed only when reviewed). Callers record them in the `config.changed` audit event.
// Mandatory rules are errors, not warnings (mandatory-rules.ts).
import type { ProjectConfig } from '@sdlc/contracts';

import { workingDayMinutes } from './calendar.js';
import { issue, type ConfigIssue } from './issues.js';
import { matrixCells, MODE_STRICTNESS, severityAtOrAbove } from './mandatory-rules.js';

function loosenedCells(config: ProjectConfig, defaults: ProjectConfig): ConfigIssue[] {
  const defaultCells = new Map(matrixCells(defaults).map((ref) => [ref.path, ref.cell]));
  return matrixCells(config).flatMap(({ path, cell }) => {
    const base = defaultCells.get(path);
    if (base === undefined) return [];
    const found: ConfigIssue[] = [];
    if (MODE_STRICTNESS[cell.mode] < MODE_STRICTNESS[base.mode]) {
      found.push(
        issue('config.warning.mode_loosened', `${path}.mode`, { from: base.mode, to: cell.mode }),
      );
    }
    if (cell.approvals < base.approvals) {
      found.push(
        issue('config.warning.approvals_reduced', `${path}.approvals`, {
          from: base.approvals,
          to: cell.approvals,
        }),
      );
    }
    return found;
  });
}

/**
 * Fewer working days or shorter working hours make working-time clocks (SLA, HOTL window, gate
 * deadline) run longer in real time. Holidays are expected; only more than 20 in one year warns.
 * Below the floor (5 days, 7 hours) the change is refused by rule M11 instead.
 */
function loosenedCalendar(config: ProjectConfig, defaults: ProjectConfig): ConfigIssue[] {
  const calendar = config.escalation.calendar;
  const base = defaults.escalation.calendar;
  const path = 'escalation.calendar';
  const removedDays = base.working_days
    .filter((day) => !calendar.working_days.includes(day))
    .map((day) => issue('config.warning.working_day_removed', `${path}.working_days`, { day }));
  const shorter =
    workingDayMinutes(calendar) < workingDayMinutes(base)
      ? [
          issue('config.warning.working_hours_shortened', `${path}.working_hours`, {
            from: workingDayMinutes(base),
            to: workingDayMinutes(calendar),
          }),
        ]
      : [];
  return [...removedDays, ...shorter, ...manyHolidays(calendar.holidays)];
}

/** More than this many holidays in one calendar year gives a warning. */
export const MAX_HOLIDAYS_PER_YEAR = 20;

function manyHolidays(holidays: readonly string[]): ConfigIssue[] {
  const perYear = new Map<string, number>();
  for (const date of holidays) {
    const year = date.slice(0, 4);
    perYear.set(year, (perYear.get(year) ?? 0) + 1);
  }
  return [...perYear.entries()]
    .filter(([, count]) => count > MAX_HOLIDAYS_PER_YEAR)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([year, count]) =>
      issue('config.warning.many_holidays', 'escalation.calendar.holidays', {
        year,
        count,
        maximum: MAX_HOLIDAYS_PER_YEAR,
      }),
    );
}

/** A higher G6 threshold lets more security findings pass without a person (QUESTIONS.md #19). */
function raisedSecurityThreshold(config: ProjectConfig, defaults: ProjectConfig): ConfigIssue[] {
  const to = config.oversight.g6_security_findings.min_severity;
  const from = defaults.oversight.g6_security_findings.min_severity;
  return severityAtOrAbove(from, to)
    ? []
    : [
        issue(
          'config.warning.g6_security_threshold_raised',
          'oversight.g6_security_findings.min_severity',
          { from, to },
        ),
      ];
}

/**
 * Above this, a Run Contract stays usable for a long time after G4 (QUESTIONS.md #33): a warning,
 * not an error, because a slow sandbox start may need it.
 */
export const MAX_CONTRACT_VALIDITY_MINUTES = 60;

function longContractValidity(config: ProjectConfig): ConfigIssue[] {
  const minutes = config.run.contract_validity_minutes;
  return minutes > MAX_CONTRACT_VALIDITY_MINUTES
    ? [
        issue('config.warning.contract_validity_long', 'run.contract_validity_minutes', {
          minutes,
          maximum: MAX_CONTRACT_VALIDITY_MINUTES,
        }),
      ]
    : [];
}

/**
 * A run cap above the default lets an agent run longer or spend more steps than template T13
 * allows (FR-32): a warning, reviewed with the change (ADR-M13).
 */
function raisedRunCaps(config: ProjectConfig, defaults: ProjectConfig): ConfigIssue[] {
  const caps = ['default_max_iterations', 'default_max_duration_minutes'] as const;
  return caps.flatMap((key) =>
    config.run[key] > defaults.run[key]
      ? [
          issue('config.warning.run_cap_raised', `run.${key}`, {
            from: defaults.run[key],
            to: config.run[key],
          }),
        ]
      : [],
  );
}

export function loosenedSettings(config: ProjectConfig, defaults: ProjectConfig): ConfigIssue[] {
  return [
    ...loosenedCells(config, defaults),
    ...raisedSecurityThreshold(config, defaults),
    ...loosenedCalendar(config, defaults),
    ...longContractValidity(config),
    ...raisedRunCaps(config, defaults),
  ];
}
