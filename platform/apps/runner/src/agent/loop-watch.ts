// Loop detection during a run (task C11 PR 2, D-08 C11 AC3, D-02 FR-35, design/ADR-M42 §2.7).
//
// Two checks on what the adapter reports on every poll (`AgentRunStatus`, counts only):
// - identical tool calls: more than the contract's `loop_threshold` identical calls in a row at
//   the end of the agent's log (config `run.loop_detection.identical_tool_calls_max`, rule M10)
//                                                                    → `loop_detected`;
// - no progress: the number of events in the log (any kind) has not grown for
//   `run.loop_detection.no_progress_window_minutes`, read from the effective configuration when
//   the run starts (rule M27: at most 30 minutes)                     → `no_progress`.
// The runner then stops the agent like at the time cap; the run ends `stopped_stalled` and goes to
// G5 (`run_cap_reached`). The run event holds counts only: never arguments, paths or commands.
import type { AgentRunStatus } from '@sdlc/contracts';

export type LoopStopReason = 'loop_detected' | 'no_progress';

export interface LoopLimits {
  /** The contract's `loop_threshold`: more identical calls in a row than this stop the run. */
  readonly identicalCallsMax: number;
  /** `run.loop_detection.no_progress_window_minutes`, in milliseconds. */
  readonly noProgressWindowMs: number;
}

/** Payload of the run event `loop_detected` (counts only), and the reason. */
export interface LoopStop {
  readonly reason: LoopStopReason;
  readonly identical_calls: number;
  readonly threshold: number;
  readonly idle_minutes: number;
}

const MINUTE_MS = 60_000;

export class LoopWatch {
  readonly #limits: LoopLimits;
  readonly #clock: () => number;
  #events = -1;
  #lastProgressAt: number;

  /** The idle clock starts when the agent starts. */
  constructor(limits: LoopLimits, clock: () => number) {
    this.#limits = limits;
    this.#clock = clock;
    this.#lastProgressAt = clock();
  }

  /**
   * Looks at one successful status read. Returns the stop when one is due; identical calls
   * first, because they say more about what went wrong.
   */
  observe(status: Pick<AgentRunStatus, 'events' | 'identicalCalls'>): LoopStop | undefined {
    const now = this.#clock();
    if (status.events !== this.#events) {
      this.#events = status.events;
      this.#lastProgressAt = now;
    }
    const idleMs = now - this.#lastProgressAt;
    const counts = {
      identical_calls: status.identicalCalls,
      threshold: this.#limits.identicalCallsMax,
      idle_minutes: Math.floor(idleMs / MINUTE_MS),
    };
    if (status.identicalCalls > this.#limits.identicalCallsMax) {
      return { reason: 'loop_detected', ...counts };
    }
    if (idleMs >= this.#limits.noProgressWindowMs) return { reason: 'no_progress', ...counts };
    return undefined;
  }
}
