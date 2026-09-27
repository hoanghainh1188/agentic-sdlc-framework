// Activities of the intent workflow (task B07, design/ADR-M30). They run in the worker process with
// the database and the registry; the workflow only sees their coded results.
import type { IntentStepResult, IntentWorkflowRef } from '@sdlc/contracts';
import { parseTenantId, stepIntent, type PlatformDatabase, type Registry } from '@sdlc/core';

export interface IntentActivities {
  /** One step of the intent (core `stepIntent`): at most one move, in one transaction. */
  stepIntent(ref: IntentWorkflowRef): Promise<IntentStepResult>;
}

export interface IntentActivityDeps {
  readonly db: Pick<PlatformDatabase, 'forTenant'>;
  readonly registry: Registry;
}

export function createIntentActivities(deps: IntentActivityDeps): IntentActivities {
  return {
    stepIntent: (ref) =>
      stepIntent(deps.db.forTenant(parseTenantId(ref.tenantId)), deps, ref.intentId),
  };
}
