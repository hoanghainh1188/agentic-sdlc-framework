// The runner process's view of its sandboxes (D-08 C04 AC3, AC5; ADR-M25 §2.7, §2.8).
//
// - Every provisioning waits for a slot of the pool (`SDLC_RUNNER_MAX_SANDBOXES`, FIFO). The slot
//   is held while the sandbox lives and freed by `release`, or at once when provisioning fails.
// - Runs are held (`HeldRuns`) from just before their workspace is reserved until `release`; the
//   sweep never touches a held run.
// - `start` cleans up after the previous process (`reconcileOnStart`) and then sweeps at the
//   configured interval. A sweep error never stops the process.
//
// The Temporal task queue `sdlc-runner` with one heartbeat activity per run (QUESTIONS #53) is
// wired in C06, where the worker side exists (D-08 C06, ADR-M25 §2.7).
import { HeldRuns } from './held.js';
import { SlotPool, type Slot } from './pool.js';
import {
  provisionRun,
  releaseSandbox,
  type ProvisionRequest,
  type ProvisionResult,
  type RunnerDeps,
} from './provision.js';
import { reconcileOnStart, sweepOrphans, type ReconcileResult } from './reconcile.js';
import type { TeardownReason } from './sandbox/lifecycle.js';

export interface RunnerHooks {
  /** Called after each clean-up (start or sweep); `main` writes the heartbeat file here. */
  readonly onCleanUp?: (kind: 'start' | 'sweep', result: ReconcileResult) => void;
  /** Called when a sweep fails as a whole (Docker unreachable); the next sweep tries again. */
  readonly onSweepError?: (error: unknown) => void;
}

export class Runner {
  readonly held = new HeldRuns();
  readonly pool: SlotPool;
  readonly #deps: RunnerDeps;
  readonly #hooks: RunnerHooks;
  readonly #slots = new Map<string, Slot>();
  #timer: NodeJS.Timeout | undefined;
  #sweeping: Promise<void> | undefined;

  constructor(deps: Omit<RunnerDeps, 'held'>, hooks: RunnerHooks = {}) {
    this.#deps = { ...deps, held: this.held };
    this.#hooks = hooks;
    this.pool = new SlotPool(deps.settings.maxSandboxes);
  }

  /** Cleans up after the previous process, then sweeps at the configured interval. */
  async start(): Promise<ReconcileResult> {
    const result = await reconcileOnStart(this.#deps);
    this.#hooks.onCleanUp?.('start', result);
    // The timer keeps the process alive until `stop`.
    this.#timer = setInterval(() => void this.sweep(), this.#deps.settings.sweepIntervalMs);
    return result;
  }

  /** One sweep; overlapping calls share the running one. */
  sweep(): Promise<void> {
    this.#sweeping ??= sweepOrphans(this.#deps, this.held)
      .then((result) => this.#hooks.onCleanUp?.('sweep', result))
      .catch((error: unknown) => this.#hooks.onSweepError?.(error))
      .finally(() => {
        this.#sweeping = undefined;
      });
    return this.#sweeping;
  }

  /** Waits for a free slot, then provisions. The slot stays taken until `release`. */
  async provision(request: ProvisionRequest, signal?: AbortSignal): Promise<ProvisionResult> {
    const slot = await this.pool.acquire(signal);
    let result: ProvisionResult | undefined;
    try {
      result = await provisionRun(this.#deps, request);
    } finally {
      if (result?.ok) this.#slots.set(result.contract.run_id, slot);
      else slot.release();
    }
    return result;
  }

  /** Removes the sandbox of a run (end of run, kill) and frees its slot. */
  async release(tenantId: string, runId: string, reason: TeardownReason): Promise<void> {
    try {
      await releaseSandbox(this.#deps, tenantId, runId, reason);
    } finally {
      // Also after a failed clean-up: the sweep then retries the objects.
      this.held.release(runId);
      this.#slots.get(runId)?.release();
      this.#slots.delete(runId);
    }
  }

  /** Stops the sweep timer and waits for a running sweep. Sandboxes are left for the next start. */
  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#sweeping;
  }
}
