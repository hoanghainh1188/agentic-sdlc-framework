// Refusals of the Cost Controller (D-08 C03, design/ADR-M24). Like `DbError`, they carry a stable
// `code`; the API, CLI and worker turn codes into user-facing text through the message catalog
// (`cost.error.<code>`, NFR-08). `message` is for logs and developers only and never holds a key.
import type { MessageKey } from '@sdlc/messages';

export const COST_ERROR_CODES = [
  /** No run, Run Contract, intent, project or tenant for the given IDs. */
  'run_not_found',
  /** The run is not waiting to start: keys are issued only for runs in `queued` or `provisioning`. */
  'run_not_startable',
  /** A label value is not a code (see `CostLabels`); `field` says which. */
  'invalid_label',
  /** The Run Contract allows no model. */
  'no_models',
  /** What is left of the intent budget is zero or less (D-02 FR-51). */
  'intent_budget_exhausted',
  /** What is left of the tenant's budget for this UTC month is zero or less (D-02 FR-51). */
  'tenant_budget_exhausted',
] as const;
export type CostErrorCode = (typeof COST_ERROR_CODES)[number];

export class CostError extends Error {
  override readonly name = 'CostError';

  constructor(
    readonly code: CostErrorCode,
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

/** Catalog key of each error code (NFR-08). `invalid_label` takes the parameter `field`. */
export const COST_ERROR_MESSAGES = {
  run_not_found: 'cost.error.run_not_found',
  run_not_startable: 'cost.error.run_not_startable',
  invalid_label: 'cost.error.invalid_label',
  no_models: 'cost.error.no_models',
  intent_budget_exhausted: 'cost.error.intent_budget_exhausted',
  tenant_budget_exhausted: 'cost.error.tenant_budget_exhausted',
} as const satisfies Record<CostErrorCode, MessageKey>;
