// Warnings for loosened, but still allowed, settings (ADR-M13: configuration changes that loosen
// control are allowed only when reviewed). Callers record them in the `config.changed` audit event.
// Mandatory rules are errors, not warnings (mandatory-rules.ts).
import type { ProjectConfig } from '@sdlc/contracts';

import { workingDayMinutes } from './calendar.js';
import { issue, type ConfigIssue } from './issues.js';
import { matrixCells, MODE_STRICTNESS } from './mandatory-rules.js';

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
 * deadline) run longer in real time. Holidays are expected and give no warning.
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
  return [...removedDays, ...shorter];
}

export function loosenedSettings(config: ProjectConfig, defaults: ProjectConfig): ConfigIssue[] {
  return [...loosenedCells(config, defaults), ...loosenedCalendar(config, defaults)];
}
