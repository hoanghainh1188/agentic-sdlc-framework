// Sandbox slots (D-08 C04 AC3, D-03 §10.1, ADR-M25 §2.7). The Temporal task queue `sdlc-runner`
// limits concurrent runs first (QUESTIONS #53); this pool is the backstop inside the process: at
// most `size` sandboxes exist at once, extra runs wait in arrival order (FIFO).
import { RunnerError } from './errors.js';

export interface Slot {
  /** Frees the slot. Safe to call more than once. */
  release(): void;
}

interface Waiter {
  readonly grant: (slot: Slot) => void;
  readonly fail: (error: Error) => void;
}

export class SlotPool {
  readonly size: number;
  #active = 0;
  readonly #queue: Waiter[] = [];

  constructor(size: number) {
    if (!Number.isSafeInteger(size) || size < 1) throw new RangeError('pool size must be >= 1');
    this.size = size;
  }

  get active(): number {
    return this.#active;
  }

  get waiting(): number {
    return this.#queue.length;
  }

  /**
   * Waits for a free slot. An aborted wait leaves the queue without taking a slot and rejects with
   * `runner.slot_wait_aborted`.
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

  #slot(): Slot {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        const next = this.#queue.shift();
        // The slot passes straight to the next waiter; `active` stays the same.
        if (next) next.grant(this.#slot());
        else this.#active -= 1;
      },
    };
  }
}

function aborted(): RunnerError {
  return new RunnerError('runner.slot_wait_aborted');
}
