// The check loop of a project's evaluation tasks (task L07, design/ADR-M85 §2.5): a plain loop in
// the worker process, like the evaluation loop (never a Temporal schedule). The database is the
// source of truth; a Temporal workflow per check attempt carries the wait for a runner slot.
//
// Every pass visits the tenants with a task to check or being checked (IDs only) and, for each:
// 1. a task `checking` whose workflow is not running (the worker stopped, a lost workflow) goes
//    back to `registered` and is handed over again (at most `MAX_TASK_CHECK_ATTEMPTS` times);
// 2. registered tasks are prepared while there is room (`maxInFlight`): the card read again on
//    the default branch (removed: `gone`; changed: `card_changed`), the signed contract and the
//    wrapped token (`prepareTaskCheck`), then the workflow is started.
// A pass never throws: an error is logged as a code and the task is tried again by the next pass.
import type { EvaluationTaskCheckDispatcher } from '@sdlc/contracts';
import type {
  PlatformDatabase,
  PrepareTaskCheckResult,
  SystemScope,
  TenantId,
  TenantScope,
} from '@sdlc/core';

import type { WorkerLogger } from './logger.js';

const TENANTS_PER_PASS = 200;
const TASKS_PER_TENANT = 50;

export interface TaskCheckLoopDeps {
  listTenants(limit: number): ReturnType<SystemScope['listTenantsWithTasksToCheck']>;
  forTenant: PlatformDatabase['forTenant'];
  prepare(scope: TenantScope, evaluationTaskId: string): Promise<PrepareTaskCheckResult>;
  readonly dispatcher: EvaluationTaskCheckDispatcher;
  readonly logger: WorkerLogger;
  /** Checks handed to the runner at most at one time, over all tenants. */
  readonly maxInFlight: number;
}

export interface TaskCheckPass {
  readonly handedOver: number;
  readonly requeued: number;
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

export class TaskCheckLoop {
  readonly #deps: TaskCheckLoopDeps;
  #timer: NodeJS.Timeout | undefined;
  #ticking: Promise<unknown> | undefined;
  #stopped = false;

  constructor(deps: TaskCheckLoopDeps) {
    this.#deps = deps;
  }

  /** One pass over the tenants with tasks to check. Never throws. */
  async pass(): Promise<TaskCheckPass> {
    const totals = { handedOver: 0, requeued: 0, refused: 0, failed: 0 };
    let tenants: readonly TenantId[];
    try {
      tenants = await this.#deps.listTenants(TENANTS_PER_PASS);
    } catch (error) {
      this.#deps.logger.log('error', 'worker.task_check_failed', {
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
        const checking = await scope.evaluationTasks.listByStatus('checking', TASKS_PER_TENANT);
        for (const task of checking) {
          const ref = {
            tenantId: scope.tenantId,
            evaluationTaskId: task.id,
            cardSha256: task.card_sha256,
            attempt: task.check_attempt,
          };
          if (await this.#deps.dispatcher.isRunning(ref)) {
            inFlight += 1;
            continue;
          }
          if (await scope.evaluationTasks.requeueCheck(task.id, task.card_sha256)) {
            totals.requeued += 1;
            this.#deps.logger.log('warn', 'worker.task_check_requeued', { task_id: task.id });
          }
        }
        const room = this.#deps.maxInFlight - inFlight;
        if (room <= 0) continue;
        for (const task of await scope.evaluationTasks.listByStatus('registered', room)) {
          if (this.#stopped) break;
          try {
            const result = await this.#deps.prepare(scope, task.id);
            if (!result.ok) {
              totals.refused += 1;
              this.#deps.logger.log('info', 'worker.task_check_refused', {
                task_id: task.id,
                reason: result.reason,
              });
              continue;
            }
            await this.#deps.dispatcher.start(result.input);
            totals.handedOver += 1;
            inFlight += 1;
            this.#deps.logger.log('info', 'worker.task_check_handed_over', {
              task_id: task.id,
              attempt: result.input.attempt,
            });
          } catch (error) {
            totals.failed += 1;
            this.#deps.logger.log('error', 'worker.task_check_failed', {
              step: 'prepare',
              task_id: task.id,
              error: errorCode(error),
            });
          }
        }
      } catch (error) {
        totals.failed += 1;
        this.#deps.logger.log('error', 'worker.task_check_failed', {
          step: 'tenant',
          tenant_id: tenantId,
          error: errorCode(error),
        });
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
