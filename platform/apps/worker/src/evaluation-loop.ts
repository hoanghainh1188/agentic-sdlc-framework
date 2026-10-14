// The evaluation loop (task L04, design/ADR-M81 §2.8, QUESTIONS #461): a plain loop in the worker
// process, like the escalation clock loop (ADR-M28). The database is the source of truth; a
// Temporal workflow per run attempt carries the long wait (`evaluationRunWorkflow`).
//
// Every pass visits the tenants that have an open evaluation (IDs only) and, for each one:
// 1. stops the runs of an evaluation that already ended (cancels their workflows);
// 2. looks at the runs handed over earlier (a contract for the current attempt): one without a
//    live workflow (the worker stopped between the contract and the start) gets its next attempt;
// 3. prepares queued runs while there is room (`maxInFlight`): contract, capped key, wrapping
//    tokens (`prepareEvaluationRun`), then starts the workflow. A run is not prepared while the
//    workflow of its previous attempt lives, so its key is never revoked by the earlier finish.
// Free sandbox slots, and a real run first, are the runner's rule (ADR-M81 §2.3); the loop only
// limits how many runs wait there, so a contract does not expire in a queue.
// A pass never throws: an error is logged as a code and the run is tried again by the next pass;
// after `MAX_PREPARE_FAILURES` in a row (in this process) the run is cancelled (`prepare_failed`).
import type { EvaluationRunDispatcher } from '@sdlc/contracts';
import type {
  PlatformDatabase,
  PrepareEvaluationResult,
  SystemScope,
  TenantId,
  TenantScope,
} from '@sdlc/core';

import type { WorkerLogger } from './logger.js';

export const MAX_PREPARE_FAILURES = 5;
/** Stop reason of a run that could not be handed over (a code). */
export const PREPARE_FAILED = 'prepare_failed';

const TENANTS_PER_PASS = 200;
const RUNS_PER_TENANT = 50;

export interface EvaluationLoopDeps {
  listTenants(limit: number): ReturnType<SystemScope['listTenantsWithOpenEvaluations']>;
  forTenant: PlatformDatabase['forTenant'];
  prepare(scope: TenantScope, evaluationRunId: string): Promise<PrepareEvaluationResult>;
  readonly dispatcher: EvaluationRunDispatcher;
  readonly logger: WorkerLogger;
  /** Runs handed to the runner at most at one time, over all tenants. */
  readonly maxInFlight: number;
}

export interface EvaluationPass {
  readonly handedOver: number;
  readonly stopped: number;
  readonly requeued: number;
  readonly failed: number;
}

/** A code for logs, never an error message. */
function errorCode(error: unknown): string {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return error instanceof Error ? error.name : 'unexpected';
}

export class EvaluationLoop {
  readonly #deps: EvaluationLoopDeps;
  /** Run ID → failed preparations in a row, in this process. */
  readonly #failures = new Map<string, number>();
  #timer: NodeJS.Timeout | undefined;
  #ticking: Promise<unknown> | undefined;
  #stopped = false;

  constructor(deps: EvaluationLoopDeps) {
    this.#deps = deps;
  }

  /** One pass over the tenants with open evaluations. Never throws. */
  async pass(): Promise<EvaluationPass> {
    const totals = { handedOver: 0, stopped: 0, requeued: 0, failed: 0 };
    let tenants: readonly TenantId[];
    try {
      tenants = await this.#deps.listTenants(TENANTS_PER_PASS);
    } catch (error) {
      this.#deps.logger.log('error', 'worker.evaluation_failed', {
        step: 'list',
        error: errorCode(error),
      });
      return { ...totals, failed: 1 };
    }
    let inFlight = 0;
    for (const tenantId of tenants) {
      if (this.#stopped) break;
      try {
        const scope = this.#deps.forTenant(tenantId);
        totals.stopped += await this.#stopClosed(scope);
        totals.requeued += await this.#requeueLost(scope);
        inFlight += await scope.evaluationRuns.countInFlight();
        const room = this.#deps.maxInFlight - inFlight;
        if (room > 0) {
          const handed = await this.#handOver(scope, room);
          totals.handedOver += handed.ok;
          totals.failed += handed.failed;
          inFlight += handed.ok;
        }
      } catch (error) {
        totals.failed += 1;
        this.#deps.logger.log('error', 'worker.evaluation_failed', {
          step: 'tenant',
          tenant_id: tenantId,
          error: errorCode(error),
        });
      }
    }
    return totals;
  }

  async #stopClosed(scope: TenantScope): Promise<number> {
    const runs = await scope.evaluationRuns.runningOfClosedEvaluations(RUNS_PER_TENANT);
    for (const run of runs) {
      await this.#deps.dispatcher.cancel({
        tenantId: scope.tenantId,
        evaluationRunId: run.id,
        attempt: run.attempt,
      });
    }
    return runs.length;
  }

  async #requeueLost(scope: TenantScope): Promise<number> {
    let moved = 0;
    for (const run of await scope.evaluationRuns.listHandedOver(RUNS_PER_TENANT)) {
      const ref = { tenantId: scope.tenantId, evaluationRunId: run.id, attempt: run.attempt };
      if (await this.#deps.dispatcher.isRunning(ref)) continue;
      // A workflow that ended without freeing the run, or never started: the contract is of no
      // use any more (its wrapping tokens are gone); the next attempt gets a new one.
      if (await scope.evaluationRuns.nextAttempt(run.id, run.attempt)) {
        moved += 1;
        this.#deps.logger.log('warn', 'worker.evaluation_requeued', { run_id: run.id });
      }
    }
    return moved;
  }

  async #handOver(scope: TenantScope, room: number): Promise<{ ok: number; failed: number }> {
    let ok = 0;
    let failed = 0;
    for (const run of await scope.evaluationRuns.listToPrepare(room)) {
      if (this.#stopped) break;
      const { dispatcher } = this.#deps;
      if (
        run.attempt > 1 &&
        (await dispatcher.isRunning({
          tenantId: scope.tenantId,
          evaluationRunId: run.id,
          attempt: run.attempt - 1,
        }))
      ) {
        continue;
      }
      try {
        const result = await this.#deps.prepare(scope, run.id);
        if (!result.ok) {
          this.#deps.logger.log('info', 'worker.evaluation_refused', {
            run_id: run.id,
            reason: result.reason,
          });
          continue;
        }
        await dispatcher.start({
          tenantId: result.run.tenantId,
          evaluationRunId: result.run.evaluationRunId,
          attempt: result.run.attempt,
          keyIssuedAt: result.run.keyIssuedAt.toISOString(),
          wrappedGitToken: result.run.wrappedGitToken,
          wrappedVirtualKey: result.run.wrappedVirtualKey,
        });
        this.#failures.delete(run.id);
        ok += 1;
        this.#deps.logger.log('info', 'worker.evaluation_run_handed_over', {
          run_id: run.id,
          attempt: run.attempt,
        });
      } catch (error) {
        failed += 1;
        const count = (this.#failures.get(run.id) ?? 0) + 1;
        this.#failures.set(run.id, count);
        this.#deps.logger.log('error', 'worker.evaluation_failed', {
          step: 'prepare',
          run_id: run.id,
          error: errorCode(error),
          failures: count,
        });
        if (count >= MAX_PREPARE_FAILURES) {
          await scope.evaluationRuns.cancelOne(run.id, PREPARE_FAILED);
          this.#failures.delete(run.id);
        }
      }
    }
    return { ok, failed };
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
