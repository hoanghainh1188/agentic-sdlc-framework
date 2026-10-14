// Sandbox slots (D-08 C04 AC3, D-03 §10.1, ADR-M25 §2.7; evaluation rule: task L04, ADR-M81 §2.3,
// QUESTIONS #461). The Temporal task queue `sdlc-runner` limits concurrent runs first
// (QUESTIONS #53); this pool is the backstop inside the process: at most `size` sandboxes exist at
// once, extra runs wait in arrival order (FIFO).
//
// Evaluation runs share the pool but never take a slot a real run needs:
// - they use **free slots only**, at most `evalSize` at the same time (default 1);
// - a waiting real run is served before any waiting evaluation run, whatever their order;
// - an evaluation run is granted only when no real run waits;
// - when a real run waits and no slot is free, the evaluation runs that hold slots are asked to
//   stop (`onPreempt`, newest first, as many as real runs wait). They free their slot when they
//   have stopped: the evaluation activity interrupts the agent, marks the run `preempted` and
//   releases (it is queued again and not counted).
import { RunnerError } from './errors.js';

export interface Slot {
  /** Frees the slot. Safe to call more than once. */
  release(): void;
}

interface Waiter {
  readonly grant: (slot: Slot) => void;
  readonly fail: (error: Error) => void;
}

interface EvaluationWaiter extends Waiter {
  readonly onPreempt: () => void;
}

interface EvaluationHolder {
  readonly onPreempt: () => void;
  preempted: boolean;
}

export class SlotPool {
  readonly size: number;
  /** Slots evaluation runs may hold at the same time; 0 turns evaluations off. */
  readonly evalSize: number;
  #active = 0;
  readonly #queue: Waiter[] = [];
  readonly #evalQueue: EvaluationWaiter[] = [];
  /** Oldest first. */
  readonly #evalHolders: EvaluationHolder[] = [];

  constructor(size: number, evalSize = 0) {
    if (!Number.isSafeInteger(size) || size < 1) throw new RangeError('pool size must be >= 1');
    if (!Number.isSafeInteger(evalSize) || evalSize < 0 || evalSize > size) {
      throw new RangeError('evaluation slots must be from 0 to the pool size');
    }
    this.size = size;
    this.evalSize = evalSize;
  }

  /** Slots taken, real runs and evaluation runs together. */
  get active(): number {
    return this.#active;
  }

  /** Real runs waiting for a slot. */
  get waiting(): number {
    return this.#queue.length;
  }

  /** Slots evaluation runs hold. */
  get activeEvaluations(): number {
    return this.#evalHolders.length;
  }

  /** Evaluation runs waiting for a free slot. */
  get waitingEvaluations(): number {
    return this.#evalQueue.length;
  }

  /**
   * Waits for a free slot (a real run). An aborted wait leaves the queue without taking a slot and
   * rejects with `runner.slot_wait_aborted`. When no slot is free, evaluation runs holding slots
   * are asked to stop.
   */
  acquire(signal?: AbortSignal): Promise<Slot> {
    if (signal?.aborted) return Promise.reject(aborted());
    if (this.#active < this.size) {
      this.#active += 1;
      return Promise.resolve(this.#slot());
    }
    return new Promise<Slot>((resolve, reject) => {
      const waiter: Waiter = {
        grant: (slot) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(slot);
        },
        fail: reject,
      };
      const onAbort = () => {
        const index = this.#queue.indexOf(waiter);
        if (index >= 0) this.#queue.splice(index, 1);
        reject(aborted());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#queue.push(waiter);
      this.#preempt();
    });
  }

  /**
   * Waits for a free slot for an evaluation run: granted only while an evaluation slot is free, the
   * pool has a free slot and no real run waits. `onPreempt` is called once when a real run needs
   * the slot; the holder then stops and calls `release`. An aborted wait rejects with
   * `runner.slot_wait_aborted`; with evaluations off it rejects at once (`runner.eval_slots_off`).
   */
  acquireEvaluation(onPreempt: () => void, signal?: AbortSignal): Promise<Slot> {
    if (this.evalSize === 0) return Promise.reject(new RunnerError('runner.eval_slots_off'));
    if (signal?.aborted) return Promise.reject(aborted());
    if (this.#canGrantEvaluation()) return Promise.resolve(this.#evaluationSlot(onPreempt));
    return new Promise<Slot>((resolve, reject) => {
      const waiter: EvaluationWaiter = {
        onPreempt,
        grant: (slot) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(slot);
        },
        fail: reject,
      };
      const onAbort = () => {
        const index = this.#evalQueue.indexOf(waiter);
        if (index >= 0) this.#evalQueue.splice(index, 1);
        reject(aborted());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#evalQueue.push(waiter);
    });
  }

  /** Runs `work` inside a slot and always frees it, also when `work` fails. */
  async withSlot<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const slot = await this.acquire(signal);
    try {
      return await work();
    } finally {
      slot.release();
    }
  }

  #canGrantEvaluation(): boolean {
    return (
      this.#evalHolders.length < this.evalSize &&
      this.#active < this.size &&
      this.#queue.length === 0
    );
  }

  /** Asks evaluation runs to stop: one per waiting real run that no stopping run already covers. */
  #preempt(): void {
    let needed = this.#queue.length - this.#evalHolders.filter((h) => h.preempted).length;
    for (let i = this.#evalHolders.length - 1; i >= 0 && needed > 0; i--) {
      const holder = this.#evalHolders[i]!;
      if (holder.preempted) continue;
      holder.preempted = true;
      needed -= 1;
      try {
        holder.onPreempt();
      } catch {
        // a failing callback must not block the real run; the holder is still marked
      }
    }
  }

  /** After a slot was freed: evaluation runs that were waiting, when nothing real waits. */
  #serveEvaluations(): void {
    while (this.#evalQueue.length > 0 && this.#canGrantEvaluation()) {
      const next = this.#evalQueue.shift()!;
      next.grant(this.#evaluationSlot(next.onPreempt));
    }
  }

  #slot(): Slot {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.#freed();
      },
    };
  }

  #evaluationSlot(onPreempt: () => void): Slot {
    this.#active += 1;
    const holder: EvaluationHolder = { onPreempt, preempted: false };
    this.#evalHolders.push(holder);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        const index = this.#evalHolders.indexOf(holder);
        if (index >= 0) this.#evalHolders.splice(index, 1);
        this.#freed();
      },
    };
  }

  /** A slot is free: it passes straight to the next real run, else to a waiting evaluation run. */
  #freed(): void {
    const next = this.#queue.shift();
    if (next) {
      // `active` stays the same: the slot changes hands.
      next.grant(this.#slot());
      return;
    }
    this.#active -= 1;
    this.#serveEvaluations();
  }
}

function aborted(): RunnerError {
  return new RunnerError('runner.slot_wait_aborted');
}
