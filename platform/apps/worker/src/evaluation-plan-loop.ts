// The evaluation plan loop (task L05, design/ADR-M82 §2.4, QUESTIONS #472, #476): a plain loop in
// the worker process, never a Temporal schedule. Every pass visits the tenants with plan work (a
// Run now request, a schedule that is due, an `on_change` plan, a pause that ended; IDs only) and
// advances each of their plans one step (core `advanceEvaluationPlan`). It starts evaluations; the
// evaluation loop of L04 hands their runs to the runner. A pass never throws: an error is logged as
// a code and the plan is tried again by the next pass.
import type { PlanStep, SystemScope, TenantId, TenantScope } from '@sdlc/core';

import type { WorkerLogger } from './logger.js';

const TENANTS_PER_PASS = 200;
const PLANS_PER_TENANT = 200;

export interface EvaluationPlanLoopDeps {
  listTenants(now: Date, limit: number): ReturnType<SystemScope['listTenantsWithPlanWork']>;
  forTenant(tenantId: TenantId): TenantScope;
  advance(scope: TenantScope, planId: string): Promise<PlanStep>;
  now(): Date;
  readonly logger: WorkerLogger;
}

export interface PlanLoopPass {
  readonly started: number;
  readonly refused: number;
  readonly failed: number;
}

/** A code for logs, never an error message. */
function errorCode(error: unknown): string {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return error instanceof Error ? error.name : 'unexpected';
}

export class EvaluationPlanLoop {
  readonly #deps: EvaluationPlanLoopDeps;
  #timer: NodeJS.Timeout | undefined;
  #ticking: Promise<unknown> | undefined;
  #stopped = false;

  constructor(deps: EvaluationPlanLoopDeps) {
    this.#deps = deps;
  }

  async pass(): Promise<PlanLoopPass> {
    const totals = { started: 0, refused: 0, failed: 0 };
    let tenants: readonly TenantId[];
    try {
      tenants = await this.#deps.listTenants(this.#deps.now(), TENANTS_PER_PASS);
    } catch (error) {
      this.#deps.logger.log('error', 'worker.evaluation_plan_failed', {
        step: 'list',
        error: errorCode(error),
      });
      return { ...totals, failed: 1 };
    }
    for (const tenantId of tenants) {
      if (this.#stopped) break;
      let plans;
      const scope = this.#deps.forTenant(tenantId);
      try {
        plans = await scope.evaluationPlans.listOpen(PLANS_PER_TENANT);
      } catch (error) {
        totals.failed += 1;
        this.#deps.logger.log('error', 'worker.evaluation_plan_failed', {
          step: 'tenant',
          tenant_id: tenantId,
          error: errorCode(error),
        });
        continue;
      }
      for (const plan of plans) {
        if (this.#stopped) break;
        try {
          const step = await this.#deps.advance(scope, plan.id);
          if (step.outcome === 'started') {
            totals.started += 1;
            this.#deps.logger.log('info', 'worker.evaluation_plan_started', {
              plan_id: plan.id,
              evaluation_id: step.evaluationId,
              reason: step.reason,
            });
          } else if (step.outcome === 'refused') {
            totals.refused += 1;
            this.#deps.logger.log('info', 'worker.evaluation_plan_refused', {
              plan_id: plan.id,
              code: step.code,
              reason: step.reason,
            });
          }
        } catch (error) {
          totals.failed += 1;
          this.#deps.logger.log('error', 'worker.evaluation_plan_failed', {
            step: 'plan',
            plan_id: plan.id,
            error: errorCode(error),
          });
        }
      }
    }
    return totals;
  }

  start(tickMs: number): void {
    const loop = (): void => {
      if (this.#stopped) return;
      this.#ticking = this.pass().finally(() => {
        if (!this.#stopped) this.#timer = setTimeout(loop, tickMs);
      });
    };
    loop();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#timer);
    await this.#ticking;
  }
}
