// The words of a refused or failed dashboard action (U07): a gate decision, a kill, an
// escalation acknowledgement or decision, a new intent. Every text comes from the catalog
// (NFR-08); the API's code is only a parameter, shown as text.
import { ApiError } from '../api/client.js';
import { t } from '../i18n.js';
import { PasskeyCancelled } from '../views/step-up.js';

// The refusal reasons the API gives for a gate decision, with their catalog keys, written out
// so a test finds every key (the same sentences as the comment replies, `gate.reason.*`).
export const REFUSAL_KEYS: Readonly<Record<string, string>> = {
  actor_not_human: 'gate.reason.actor_not_human',
  producer: 'gate.reason.producer',
  no_human_decision: 'gate.reason.no_human_decision',
  role_missing: 'gate.reason.role_missing',
  already_approved: 'gate.reason.already_approved',
  role_already_covered: 'gate.reason.role_already_covered',
  approvals_complete: 'gate.reason.approvals_complete',
  decision_not_for_actor: 'gate.reason.decision_not_for_actor',
  reason_required: 'gate.reason.reason_required',
  hitl_needs_a_person: 'gate.reason.hitl_needs_a_person',
};

/** The reason codes a person may give with a reject or an escalation decision. */
export const DECISION_REASON_CODES = [
  'spec_unclear',
  'tests_insufficient',
  'security_finding',
  'out_of_scope',
  'policy_denied',
  'budget_exceeded',
] as const;

/** The catalog text of an action's error. */
export function actionErrorText(error: unknown): string {
  if (error instanceof PasskeyCancelled) return t('dashboard.action.cancelled');
  if (!(error instanceof ApiError))
    return t('dashboard.action.error.failed', { code: 'unexpected' });
  if (error.reason !== undefined && Object.hasOwn(REFUSAL_KEYS, error.reason)) {
    return t(REFUSAL_KEYS[error.reason]!);
  }
  if (error.code === 'gate_input_conflict') return t('dashboard.action.conflict');
  if (error.code === 'step_up_refused') return t('dashboard.action.error.step_up');
  if (error.code === 'passkey_not_found') return t('dashboard.action.error.no_passkey');
  if (error.code === 'dashboard_actions_off') return t('dashboard.passkeys.error.actions_off');
  if (error.status === 401) return t('dashboard.error.unauthorized');
  return t('dashboard.action.error.failed', { code: error.code });
}
