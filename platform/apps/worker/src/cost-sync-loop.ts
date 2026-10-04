// The scheduled spend sync (task C12, design/ADR-M24 §2.5, QUESTIONS #197, #225): a plain loop in
// the worker process, like the escalation clock loop (ADR-M28), instead of the Temporal schedule
// ADR-M24 first named. `CostController.syncSpend` copies the gateway's call records into
// `cost_records`; running it again on the same range inserts nothing.
//
// - Every pass syncs `[from, now)`. Normally `from = now − lookback`, because LiteLLM writes spend
//   logs in batches; the first pass after a start reaches back the catch-up window (the time the
//   worker was down).
// - `from` also reaches back to the start of every run that ended within the settle window, so a
//   run longer than the look-back is synced once more, whole, shortly after it ends.
// - A failed pass is retried by the next one from the slice that failed, never later than
//   `now − catch_up`; a range cut at that limit is logged as `worker.cost_sync_gap`.
// - The range is read in slices oldest first, so a long window stays under the gateway's page cap;
//   a slice the gateway cannot read whole (`truncated`) fails the pass instead of dropping rows.
// - Only one process syncs at a time (a PostgreSQL advisory lock); the loop never throws.
import type { SpendSyncLockResult, SyncRange, SyncResult } from '@sdlc/core';

import type { WorkerLogger } from './logger.js';
import type { CostSyncSettings } from './settings.js';

/** Length of one gateway read. Small enough for the page cap, large enough for few reads. */
export const COST_SYNC_SLICE_MS = 60 * 60_000;

export interface CostSyncLoopDeps {
  sync(range: SyncRange): Promise<SyncResult>;
  /** `SystemScope.earliestStartOfRunsEndedSince`. */
  earliestStartOfRunsEndedSince(since: Date): Promise<Date | null>;
  /** `SystemScope.withSpendSyncLock`. */
  withLock<T>(fn: () => Promise<T>): Promise<SpendSyncLockResult<T>>;
  now(): Date;
  readonly logger: WorkerLogger;
  readonly settings: CostSyncSettings;
}

export type CostSyncPass =
  | { readonly outcome: 'synced'; readonly from: Date; readonly to: Date }
  | { readonly outcome: 'failed'; readonly retryFrom: Date }
  | { readonly outcome: 'busy' };

/** A code for logs, never an error message. */
function errorCode(error: unknown): string {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return error instanceof Error ? error.name : 'unexpected';
}

const minutes = (ms: number): number => Math.ceil(ms / 60_000);

export class CostSyncLoop {
  readonly #deps: CostSyncLoopDeps;
  /** Where the next pass must start at the latest: `start` after a start, a time after a failure. */
  #retryFrom: Date | 'start' | null = 'start';
  #timer: NodeJS.Timeout | undefined;
  #ticking: Promise<unknown> | undefined;
  #stopped = false;

  constructor(deps: CostSyncLoopDeps) {
    this.#deps = deps;
  }

  /** One pass. Never throws: a failure is logged and retried by the next pass. */
  async tick(): Promise<CostSyncPass> {
    try {
      const locked = await this.#deps.withLock(() => this.#pass());
      if (locked.ran) return locked.value;
      this.#deps.logger.log('info', 'worker.cost_sync_busy', {});
      return { outcome: 'busy' };
    } catch (error) {
      // The lock or the run query failed: nothing was synced, keep the retry point.
      this.#deps.logger.log('error', 'worker.cost_sync_failed', { error: errorCode(error) });
      if (this.#retryFrom === null) {
        this.#retryFrom = new Date(this.#deps.now().getTime() - this.#deps.settings.lookbackMs);
      }
      const retryFrom =
        this.#retryFrom === 'start'
          ? new Date(this.#deps.now().getTime() - this.#deps.settings.catchUpMs)
          : this.#retryFrom;
      return { outcome: 'failed', retryFrom };
    }
  }

  async #pass(): Promise<CostSyncPass> {
    const { settings, logger } = this.#deps;
    const to = this.#deps.now();
    const floor = new Date(to.getTime() - settings.catchUpMs);
    let from = new Date(to.getTime() - settings.lookbackMs);
    if (this.#retryFrom === 'start') {
      from = floor;
    } else if (this.#retryFrom !== null && this.#retryFrom < from) {
      if (this.#retryFrom < floor) {
        // Failures lasted longer than the catch-up window: these calls need a manual sync.
        logger.log('warn', 'worker.cost_sync_gap', {
          uncovered_minutes: minutes(floor.getTime() - this.#retryFrom.getTime()),
        });
        from = floor;
      } else {
        from = this.#retryFrom;
      }
    }
    const ended = await this.#deps.earliestStartOfRunsEndedSince(
      new Date(to.getTime() - settings.settleMs),
    );
    // Calls of a long run before the look-back were synced while it ran; the floor still holds.
    if (ended !== null && ended < from) from = ended < floor ? floor : ended;

    const totals = { slices: 0, seen: 0, inserted: 0, duplicates: 0 };
    const skipped: Record<string, number> = {};
    for (let start = from.getTime(); start < to.getTime(); start += COST_SYNC_SLICE_MS) {
      const slice = {
        from: new Date(start),
        to: new Date(Math.min(start + COST_SYNC_SLICE_MS, to.getTime())),
      };
      if (this.#stopped) {
        this.#retryFrom = slice.from;
        return { outcome: 'failed', retryFrom: slice.from };
      }
      let result: SyncResult;
      try {
        result = await this.#deps.sync(slice);
      } catch (error) {
        // The slices before this one are recorded; the next pass starts at this one.
        this.#retryFrom = slice.from;
        logger.log('error', 'worker.cost_sync_failed', {
          error: errorCode(error),
          slices_done: totals.slices,
          window_minutes: minutes(to.getTime() - from.getTime()),
        });
        return { outcome: 'failed', retryFrom: slice.from };
      }
      totals.slices += 1;
      totals.seen += result.seen;
      totals.inserted += result.inserted;
      totals.duplicates += result.duplicates;
      for (const [reason, count] of Object.entries(result.skipped)) {
        skipped[`skipped_${reason}`] = (skipped[`skipped_${reason}`] ?? 0) + (count ?? 0);
      }
    }
    this.#retryFrom = null;
    logger.log('info', 'worker.cost_synced', {
      window_minutes: minutes(to.getTime() - from.getTime()),
      ...totals,
      ...skipped,
    });
    return { outcome: 'synced', from, to };
  }

  start(): void {
    const loop = (): void => {
      if (this.#stopped) return;
      this.#ticking = this.tick().finally(() => {
        if (!this.#stopped) this.#timer = setTimeout(loop, this.#deps.settings.intervalMs);
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
