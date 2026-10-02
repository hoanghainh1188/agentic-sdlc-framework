// The escalation clock loop (D-08 B11 AC3, design/ADR-M28 §2.2, QUESTIONS #73): a plain loop in
// the worker process, like the GitHub poller (ADR-M27 D1). It replaces, for escalations, the
// Temporal timers of D-03 §6.4 and ADR-M14: B07 must not add a second timer for the same clock.
//
// - Every tick, it reads the escalations whose clock is due (`next_check_at <= now`, IDs only)
//   and advances each one in its tenant's scope. One escalation at a time: a batch is small.
// - All state is in PostgreSQL. After a restart, the loop continues from the stored clocks; an
//   escalation that ran out while the worker was down catches up in order.
// - Two worker processes never advance the same escalation at once (`SKIP LOCKED`), and the clock
//   is idempotent, so a step is never repeated.
import { withLogContext, type AdvanceResult, type DueEscalation } from '@sdlc/core';

import type { WorkerLogger } from './logger.js';

export interface EscalationLoopDeps {
  listDue(now: Date, limit: number): Promise<readonly DueEscalation[]>;
  advance(due: DueEscalation, now: Date): Promise<AdvanceResult>;
  now(): Date;
  readonly logger: WorkerLogger;
  /** Escalations handled per tick at most; the rest wait for the next tick. */
  readonly batchSize: number;
}

/** A code for logs, never an error message. */
function errorCode(error: unknown): string {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return error instanceof Error ? error.name : 'unexpected';
}

export class EscalationLoop {
  readonly #deps: EscalationLoopDeps;
  #timer: NodeJS.Timeout | undefined;
  #ticking: Promise<void> | undefined;
  #stopped = false;

  constructor(deps: EscalationLoopDeps) {
    this.#deps = deps;
  }

  /** One pass: advances every due escalation of the batch. An error skips only that escalation. */
  async tick(): Promise<void> {
    const now = this.#deps.now();
    const due = await this.#deps.listDue(now, this.#deps.batchSize);
    for (const item of due) {
      if (this.#stopped) break;
      const fields = { tenant_id: item.tenantId, escalation_id: item.escalationId };
      try {
        const result = await withLogContext({ tenantId: item.tenantId }, () =>
          this.#deps.advance(item, now),
        );
        for (const effect of result.effects) {
          this.#deps.logger.log('info', 'worker.escalation_clock', {
            ...fields,
            effect: effect.kind,
          });
        }
      } catch (error) {
        this.#deps.logger.log('error', 'worker.escalation_failed', {
          ...fields,
          error: errorCode(error),
        });
      }
    }
  }

  start(tickMs: number): void {
    const loop = (): void => {
      if (this.#stopped) return;
      this.#ticking = this.tick()
        .catch((error: unknown) => {
          this.#deps.logger.log('error', 'worker.escalation_tick_failed', {
            error: errorCode(error),
          });
        })
        .finally(() => {
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
