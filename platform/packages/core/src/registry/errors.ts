// Refusals of the registry (D-08 B02). Like `DbError`, they carry a stable `code`; the API and CLI
// turn codes into user-facing text through the message catalog (NFR-08).
import type { ApprovalRefusal } from '@sdlc/contracts';

import type { DecisionViolation } from './decision-rules.js';

export type RegistryErrorCode =
  /** No intent with this ID in the tenant. */
  | 'intent_not_found'
  /** The project is unknown or archived: no new intents. */
  | 'project_not_active'
  /** The stored project configuration no longer validates. */
  | 'config_invalid'
  /** The stored `config_hash` differs from the hash of the stored configuration. */
  | 'config_hash_mismatch'
  /** The decision breaks a registry rule; `reason` says which. */
  | 'decision_not_allowed'
  /** The policy engine refused the approval (D-02 FR-11, FR-16); `reason` says why. */
  | 'approval_refused';

export class RegistryError extends Error {
  override readonly name = 'RegistryError';

  constructor(
    readonly code: RegistryErrorCode,
    message: string,
    readonly reason?: DecisionViolation | ApprovalRefusal,
  ) {
    super(message);
  }
}
