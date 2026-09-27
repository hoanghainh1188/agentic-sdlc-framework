// Policy engine adapter: simple rules read from the validated project configuration.
// See design/D-03 section 7.3, D-08 B01. The app loads the configuration with `@sdlc/config`
// (schema and mandatory rules M1–M16) and passes it here; this package imports contracts only.
import type { ModelRef, PolicyEngine, ValidatedProjectConfig } from '@sdlc/contracts';

import { canApprove } from './approvers.js';
import { isForbidden } from './forbidden.js';
import { resolveOversight } from './oversight.js';
import { allowedModels, maxAutonomy } from './routing.js';
import { checkScope } from './scope.js';

export interface SimplePolicyEngineOptions {
  readonly config: ValidatedProjectConfig;
  /** Models configured in the gateway (task C03). Empty: `allowedModels` returns nothing. */
  readonly models?: readonly ModelRef[];
}

export function createSimplePolicyEngine(options: SimplePolicyEngineOptions): PolicyEngine {
  const { config } = options;
  const models = options.models ?? [];
  return {
    maxAutonomy: (input) => maxAutonomy(config, input),
    oversightMode: (input) => resolveOversight(config, input),
    allowedModels: (input) => allowedModels(config, models, input.dataClass),
    checkScope: (input) => checkScope(input),
    canApprove: (input) => canApprove(config, input),
    isForbidden: (input) => isForbidden(input),
  };
}
