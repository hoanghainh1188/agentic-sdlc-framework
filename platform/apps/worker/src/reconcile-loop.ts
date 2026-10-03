// The reconcile loop of the intent workflow (task B07, design/ADR-M30 §2.3). The api and the poller
// wake an intent's workflow after they commit a change. A wake signal can be lost when a process
// stops between the commit and the signal, so this loop wakes every open intent: at start-up, then
// every `SDLC_WORKER_RECONCILE_MS`. Waking is harmless: the workflow only reads the database again,
// and signal-with-start starts a workflow that does not run yet (an intent created while Temporal
// was down).
//
// C11 (ADR-M42 §2.2): each pass also sends the kill signal again to the intents whose current run
// is being killed (`listKilling`): a kill recorded by the operator command, or a lost signal, still
// cancels a run activity that waits in Temporal for a runner slot.
import type { IntentWorkflowRef, IntentWorkflowSignals } from '@sdlc/contracts';

import type { WorkerLogger } from './logger.js';

export interface ReconcileLoopDeps {
  /** Open intents after the keyset position `after` (`SystemScope.listOpenIntents`). */
  listOpen(limit: number, after?: IntentWorkflowRef): Promise<readonly IntentWorkflowRef[]>;
  /** C11: intents whose current run is being killed (`SystemScope.listKillingIntents`). */
  listKilling?(limit: number): Promise<readonly IntentWorkflowRef[]>;
  readonly signals: IntentWorkflowSignals;
  readonly logger: WorkerLogger;
  /** Intents read per page. */
  readonly batchSize: number;
}

export class ReconcileLoop {
  readonly #deps: ReconcileLoopDeps;
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<void> | undefined;
  #stopped = false;

  constructor(deps: ReconcileLoopDeps) {
    this.#deps = deps;
  }

  /** One pass over every open intent. A failed signal skips only that intent. */
  async pass(): Promise<{ woken: number; failed: number }> {
    let woken = 0;
    let failed = 0;
    let after: IntentWorkflowRef | undefined;
    for (;;) {
      const page = await this.#deps.listOpen(this.#deps.batchSize, after);
      for (const intent of page) {
        if (this.#stopped) return { woken, failed };
        try {
          await this.#deps.signals.wake(intent);
          woken += 1;
        } catch {
          failed += 1;
          this.#deps.logger.log('warn', 'worker.wake_failed', {
            tenant_id: intent.tenantId,
            intent_id: intent.intentId,
          });
        }
      }
      if (page.length < this.#deps.batchSize) break;
      after = page.at(-1);
    }
    failed += await this.#killAgain();
    this.#deps.logger.log('info', 'worker.reconciled', { woken, failed });
    return { woken, failed };
  }

  /** Sends the kill signal again (C11). Returns the number of failed signals. */
  async #killAgain(): Promise<number> {
    if (!this.#deps.listKilling) return 0;
    let failed = 0;
    for (const intent of await this.#deps.listKilling(this.#deps.batchSize)) {
      if (this.#stopped) break;
      try {
        await this.#deps.signals.kill(intent);
      } catch {
        failed += 1;
        this.#deps.logger.log('warn', 'worker.kill_signal_failed', {
          tenant_id: intent.tenantId,
          intent_id: intent.intentId,
        });
      }
    }
    return failed;
  }

  start(intervalMs: number): void {
    const loop = (): void => {
      if (this.#stopped) return;
      this.#running = this.pass()
        .then(() => undefined)
        .catch(() => {
          this.#deps.logger.log('error', 'worker.reconcile_failed', {});
        })
        .finally(() => {
          if (!this.#stopped) this.#timer = setTimeout(loop, intervalMs);
        });
    };
    loop();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#timer);
    await this.#running;
  }
}
