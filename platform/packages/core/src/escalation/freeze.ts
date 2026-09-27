// Freezing (D-08 B11 AC4, handbook Ch.6 §6.5, QUESTIONS #76, design/ADR-M28 §2.4).
//
// While an escalation freezes an intent, only the actions on the project's safe list continue.
// This is the one place later tasks ask before acting:
//   B07 before `gate_advance`; C06 before `run_start`; C07 before `run_resume` or
//   `budget_increase`; C08 before `push` or `open_pr`; E01 before `merge`; E03 before `release`.
// Containment (`kill_run`, `revoke_credentials`, C11) is never frozen. No answer never means
// "go ahead": an escalation keeps freezing until it is closed. A decision that has not expired lets
// the actions of its scope through; the caller still re-checks its bound hash with
// `revalidateEscalationDecision` just before acting.
//
// An escalation freezes when it is not closed and either its response level is `pause`,
// `contain` or `incident`, or its acknowledgement was missed (observe and notify then freeze too).
import {
  CONTAINMENT_ACTIONS,
  FREEZING_RESPONSE_LEVELS,
  type EscalationAction,
  type ResponseLevel,
} from '@sdlc/contracts';

import type { Escalation } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { loadEffectiveConfig } from '../registry/effective-config.js';
import { decisionAllows } from './decide.js';
import { EscalationError } from './errors.js';

export interface FreezeCheck {
  readonly allowed: boolean;
  /** Codes of the escalations that freeze the intent, oldest first (empty when none). */
  readonly escalationCodes: readonly string[];
}

/** True when the escalation freezes its intent (pure). */
export function isFreezing(
  escalation: Pick<Escalation, 'status' | 'response_level' | 'ack_missed_at'>,
): boolean {
  if (escalation.status === 'closed') return false;
  return (
    (FREEZING_RESPONSE_LEVELS as readonly ResponseLevel[]).includes(escalation.response_level) ||
    escalation.ack_missed_at !== null
  );
}

/**
 * Whether `action` may run on the intent now. Containment always may; a safe-list action may; any
 * other action may only when no escalation freezes the intent. Unknown action codes are treated as
 * protected.
 */
export async function checkFreeze(
  scope: TenantScope,
  intentId: string,
  action: EscalationAction,
  at: Date = new Date(),
): Promise<FreezeCheck> {
  const allowed = { allowed: true, escalationCodes: [] };
  if ((CONTAINMENT_ACTIONS as readonly string[]).includes(action)) return allowed;
  const escalations = await scope.escalations.listForIntent(intentId, {
    statuses: ['open', 'acknowledged', 'resolved'],
  });
  const freezing = escalations.filter((e) => isFreezing(e) && !decisionAllows(e, action, at));
  if (freezing.length === 0) return allowed;
  // Without the intent there is no safe list to read: the action stays refused (fail closed).
  const intent = await scope.intents.getById(intentId);
  if (intent) {
    const { config } = await loadEffectiveConfig(scope.projectConfigs, intent.project_id);
    if ((config.escalation.safe_actions as readonly string[]).includes(action)) return allowed;
  }
  return { allowed: false, escalationCodes: freezing.map((e) => e.code) };
}

/** Like `checkFreeze`, but throws `EscalationError('frozen')` with the escalation codes. */
export async function assertActionAllowed(
  scope: TenantScope,
  intentId: string,
  action: EscalationAction,
  at: Date = new Date(),
): Promise<void> {
  const check = await checkFreeze(scope, intentId, action, at);
  if (!check.allowed) {
    throw new EscalationError(
      'frozen',
      `intent ${intentId} is frozen by ${check.escalationCodes.join(', ')}; ${action} refused`,
      check.escalationCodes,
    );
  }
}
