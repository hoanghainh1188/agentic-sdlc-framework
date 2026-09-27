// Refusals of the agent register (task C10, design/ADR-M31). Like `RegistryError`, they carry a
// stable `code`; the CLI (and C06) render codes through the message catalog
// (`agent_register.error.<code>`).
import { t, type MessageKey } from '@sdlc/messages';

export type AgentRegisterErrorCode =
  // --- register, update, status, owner, recertification (operator commands) ---
  /** A field does not have the expected format; `field` names it. */
  | 'invalid_input'
  /** The owner is not an active user of the tenant. */
  | 'owner_not_active'
  /** The agent key is taken in this tenant, also by a retired agent (Ch.20 §20.10 step 8). */
  | 'agent_exists'
  /** The status move is not in handbook Ch.20 (ADR-M31 §2.3). */
  | 'status_move_not_allowed'
  /** The agent is retired: nothing changes any more. */
  | 'agent_retired'
  /** A configuration change needs the agent `proposed` or `suspended` (Ch.20 §20.9). */
  | 'config_change_not_allowed'
  /** A configuration change needs a new version label. */
  | 'version_unchanged'
  /** Suspend, quarantine and retire need a reason code. */
  | 'reason_required'
  /** Activation needs a pinned model (D-02 FR-36). */
  | 'model_not_pinned'
  /** A recertification date in the future, or before the last one. */
  | 'recertification_date_invalid'
  // --- the check before a run (C06, D-02 FR-36) ---
  /** No agent with this ID in the tenant. */
  | 'agent_not_found'
  /** The agent is not `active`. */
  | 'agent_not_active'
  /** The run's autonomy is above the agent's `max_autonomy`. */
  | 'autonomy_above_agent'
  /** The agent is not approved for the `sandbox` environment. */
  | 'environment_not_approved'
  /** The agent's pinned model is not in the run's allowed models (QUESTIONS #79). */
  | 'model_not_allowed'
  /** The instructions file at the run's base commit differs from the registered hash. */
  | 'instructions_mismatch';

export class AgentRegisterError extends Error {
  override readonly name = 'AgentRegisterError';

  constructor(
    readonly code: AgentRegisterErrorCode,
    message: string,
    /** The field that failed (`invalid_input` only). */
    readonly field?: string,
  ) {
    super(message);
  }
}

/** Catalog keys of the refusals (NFR-08). Parameters: `key` (the agent key), `field`. */
export const AGENT_REGISTER_ERROR_MESSAGES = {
  invalid_input: 'agent_register.error.invalid_input',
  owner_not_active: 'agent_register.error.owner_not_active',
  agent_exists: 'agent_register.error.agent_exists',
  status_move_not_allowed: 'agent_register.error.status_move_not_allowed',
  agent_retired: 'agent_register.error.agent_retired',
  config_change_not_allowed: 'agent_register.error.config_change_not_allowed',
  version_unchanged: 'agent_register.error.version_unchanged',
  reason_required: 'agent_register.error.reason_required',
  model_not_pinned: 'agent_register.error.model_not_pinned',
  recertification_date_invalid: 'agent_register.error.recertification_date_invalid',
  agent_not_found: 'agent_register.error.agent_not_found',
  agent_not_active: 'agent_register.error.agent_not_active',
  autonomy_above_agent: 'agent_register.error.autonomy_above_agent',
  environment_not_approved: 'agent_register.error.environment_not_approved',
  model_not_allowed: 'agent_register.error.model_not_allowed',
  instructions_mismatch: 'agent_register.error.instructions_mismatch',
} as const satisfies Record<AgentRegisterErrorCode, MessageKey>;

/** The text of a refusal. `agentKey` names the agent in the text; missing values render as `-`. */
export function agentRegisterErrorMessage(
  error: AgentRegisterError,
  agentKey = '-',
  locale?: string,
): string {
  return t(
    AGENT_REGISTER_ERROR_MESSAGES[error.code],
    { key: agentKey, field: error.field ?? '-' },
    locale,
  );
}
