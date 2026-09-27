// The registry facade (design/D-03 section 5.2 "Intent / Spec Registry" and "Gate Engine", D-08
// B02). It holds the policy factory and the clock, so callers cannot write an intent or a gate
// decision without the policy engine of the project configuration.
import type { PolicyEngine } from '@sdlc/contracts';

import type { GateDecisionRow, Intent, Plan, SpecRef } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import type {
  DecideInput,
  RevalidateInput,
  RevalidateResult,
} from '../db/repositories/gate-decisions.js';
import type { NewIntent } from '../db/repositories/intents.js';
import type { SubmitPlan } from '../db/repositories/plans.js';
import type { LinkSpec } from '../db/repositories/spec-refs.js';
import {
  loadEffectiveConfig,
  type EffectiveConfig,
  type RegistryDeps,
} from './effective-config.js';

export class Registry {
  constructor(private readonly deps: RegistryDeps) {}

  createIntent(scope: TenantScope, input: NewIntent): Promise<Intent> {
    return scope.intents.create(input, this.deps);
  }

  linkSpec(scope: TenantScope, intentId: string, input: LinkSpec): Promise<SpecRef> {
    return scope.specRefs.link(intentId, input);
  }

  submitPlan(scope: TenantScope, intentId: string, input: SubmitPlan): Promise<Plan> {
    return scope.plans.submit(intentId, input);
  }

  decide(scope: TenantScope, input: DecideInput): Promise<GateDecisionRow> {
    return scope.gateDecisions.decide(input, this.deps);
  }

  revalidateApprovals(scope: TenantScope, input: RevalidateInput): Promise<RevalidateResult> {
    return scope.gateDecisions.revalidateApprovals(input, this.deps);
  }

  /** The policy engine of the project configuration in force (the intent workflow, B07). */
  async policyFor(
    scope: TenantScope,
    projectId: string,
  ): Promise<EffectiveConfig & { readonly policy: PolicyEngine }> {
    const effective = await loadEffectiveConfig(scope.projectConfigs, projectId);
    return { ...effective, policy: this.deps.policyFactory(effective.config) };
  }

  /** The registry clock. */
  now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }
}
