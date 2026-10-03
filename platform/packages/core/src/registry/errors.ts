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
  /**
   * The stored YAML is not the YAML the configuration was saved with (its `override_sha256`
   * differs): it was changed outside the platform. Refused until someone saves it again.
   */
  | 'config_hash_mismatch'
  /**
   * The stored YAML is unchanged but its effective hash differs: the platform defaults changed
   * (a new release). The start-up check re-hashes it (B13 AC8, QUESTIONS #95); until then refused.
   */
  | 'config_defaults_drift'
  /** The decision breaks a registry rule; `reason` says which. */
  | 'decision_not_allowed'
  /** The policy engine refused the approval (D-02 FR-11, FR-16); `reason` says why. */
  | 'approval_refused'
  /**
   * Another open intent of the project is linked to the same issue or pull request
   * (design/QUESTIONS.md #68, migration 0009).
   */
  | 'issue_already_linked';

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
