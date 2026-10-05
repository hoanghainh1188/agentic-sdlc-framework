// The retention loop (task E05, design/ADR-M51; D-05 §10.1; D-02 FR-44): a plain loop in the
// worker process, like the escalation clock loop (ADR-M28) and the spend sync (C12), not a
// Temporal schedule: it carries no workflow data, and a fake clock tests it.
//
// - Every interval one pass (`runRetentionPass`, core) under a PostgreSQL advisory lock, so one
//   process at a time deletes evidence; another holder → `worker.retention_busy`.
// - Mode `report` (the default) counts and deletes nothing; `purge` deletes. Holds and lock moves
//   run in both modes: they only protect evidence.
// - The orphan sweep goes through `packs/` one page per pass and starts again at the end.
// - The loop never throws: a failed pass is logged and the next one tries again.
// - E05 PR 2 (ADR-M51 §2.9): each pass first runs the daily audit anchor (`runAnchorPass`, core),
//   under the same lock. The loop runs when either identity is there (`worker-purge`,
//   `worker-anchor`); each part only with its own. A failed anchor pass never stops the purge.
import type {
  AnchorPassResult,
  RetentionPassDeps,
  RetentionPassResult,
  SpendSyncLockResult,
} from '@sdlc/core';

import type { WorkerLogger } from './logger.js';

export interface RetentionLoopDeps {
  /** `runAnchorPass` (core) bound to its dependencies; absent without `worker-anchor`. */
  readonly anchor?: () => Promise<AnchorPassResult>;
  /** `runRetentionPass` (core) bound to its dependencies; absent without `worker-purge`. */
  readonly pass?: (orphanCursor: string | null) => Promise<RetentionPassResult>;
  /** `SystemScope.withRetentionLock`. */
  withLock<T>(fn: () => Promise<T>): Promise<SpendSyncLockResult<T>>;
  readonly logger: WorkerLogger;
  readonly mode: RetentionPassDeps['settings']['mode'];
  readonly intervalMs: number;
}

export type RetentionLoopPass =
  | {
      readonly outcome: 'done';
      /** Null when the part did not run (no identity) or failed (logged). */
      readonly anchors: AnchorPassResult | null;
      readonly result: RetentionPassResult | null;
    }
  | { readonly outcome: 'busy' }
  | { readonly outcome: 'failed' };

function errorCode(error: unknown): string {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return error instanceof Error ? error.name : 'unexpected';
}

export class RetentionLoop {
  readonly #deps: RetentionLoopDeps;
  #orphanCursor: string | null = null;
  #timer: NodeJS.Timeout | undefined;
  #ticking: Promise<unknown> | undefined;
  #stopped = false;

  constructor(deps: RetentionLoopDeps) {
    this.#deps = deps;
  }

  /** One pass: anchors first, then the retention steps. Never throws. */
  async tick(): Promise<RetentionLoopPass> {
    try {
      const locked = await this.#deps.withLock(async () => ({
        anchors: await this.#anchors(),
        result: this.#deps.pass ? await this.#deps.pass(this.#orphanCursor) : null,
      }));
      if (!locked.ran) {
        this.#deps.logger.log('info', 'worker.retention_busy', {});
        return { outcome: 'busy' };
      }
      const { anchors, result } = locked.value;
      if (result) {
        const { orphanCursor, ...counts } = result;
        this.#orphanCursor = orphanCursor;
        this.#deps.logger.log(counts.failed > 0 ? 'warn' : 'info', 'worker.retention_pass', {
          mode: this.#deps.mode,
          ...counts,
        });
      }
      return { outcome: 'done', anchors, result };
    } catch (error) {
      this.#deps.logger.log('error', 'worker.retention_failed', { error: errorCode(error) });
      return { outcome: 'failed' };
    }
  }

  /** The anchor pass; a failure is logged and never stops the retention steps. */
  async #anchors(): Promise<AnchorPassResult | null> {
    if (!this.#deps.anchor) return null;
    try {
      const counts = await this.#deps.anchor();
      const bad = counts.failed + counts.mismatched + counts.unlocked > 0;
      this.#deps.logger.log(bad ? 'warn' : 'info', 'worker.anchor_pass', { ...counts });
      return counts;
    } catch (error) {
      this.#deps.logger.log('error', 'worker.anchor_pass_failed', { error: errorCode(error) });
      return null;
    }
  }

  start(): void {
    const loop = (): void => {
      if (this.#stopped) return;
      this.#ticking = this.tick().finally(() => {
        if (!this.#stopped) this.#timer = setTimeout(loop, this.#deps.intervalMs);
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
