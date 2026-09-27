// Who is told what, and when (handbook Ch.6 §6.4 SLA "Notify", §6.5; codes table §6.3;
// design/ADR-M28 §2.5). The clock and `raiseEscalation` record notices in `escalation_notices`
// (codes only); PR 2 of B11 posts them as comments on the intent's issue, rendered from the
// message catalog. Each notice names a role, never a person, so it is still right when a role
// changes hands before the comment is posted.
import type {
  EscalationNoticeKind,
  EscalationRoute,
  EscalationStep,
  ProjectRole,
  Severity,
  ValidatedProjectConfig,
} from '@sdlc/contracts';

import type { ClockEffect } from './clock.js';
import { GOVERNANCE_ROLE, stepRole } from './routing.js';

type EscalationSettings = ValidatedProjectConfig['escalation'];

export interface NoticeToRecord {
  readonly kind: EscalationNoticeKind;
  readonly step: EscalationStep;
  readonly audienceRole: ProjectRole;
}

function notices(
  kind: EscalationNoticeKind,
  step: EscalationStep,
  roles: readonly ProjectRole[],
): NoticeToRecord[] {
  return [...new Set(roles)]
    .filter((role) => role !== 'viewer')
    .map((audienceRole) => ({ kind, step, audienceRole }));
}

/**
 * When an escalation is raised: the holder role of its first step, plus the roles of
 * `notify_on_raise` for its severity. A Critical escalation always tells governance at once
 * (codes table §6.3; rule M17), so leadership never waits for the step chain.
 */
export function raisedNotices(
  route: EscalationRoute,
  severity: Severity,
  step: EscalationStep,
  settings: EscalationSettings,
): NoticeToRecord[] {
  const routing = settings.routing[route];
  return notices('raised', step, [stepRole(step, routing), ...settings.notify_on_raise[severity]]);
}

/** Notices for one clock effect. */
export function clockNotices(
  effect: ClockEffect,
  route: EscalationRoute,
  settings: EscalationSettings,
): NoticeToRecord[] {
  const routing = settings.routing[route];
  switch (effect.kind) {
    case 'reminded':
      return notices('reminder', effect.step, [stepRole(effect.step, routing)]);
    case 'step_changed':
      // The new holder, and the one who missed it, so both know where it is now.
      return notices('step_changed', effect.to, [
        stepRole(effect.to, routing),
        stepRole(effect.from, routing),
      ]);
    case 'governance_overdue':
      return notices('ack_overdue', 'governance', [GOVERNANCE_ROLE]);
    case 'resolve_overdue':
      return [
        ...notices('resolve_overdue', 'governance', [
          GOVERNANCE_ROLE,
          stepRole(effect.from, routing),
        ]),
        ...(effect.incident ? notices('incident_due', 'governance', [GOVERNANCE_ROLE]) : []),
      ];
  }
}
