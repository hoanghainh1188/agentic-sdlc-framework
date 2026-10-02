// The runner's spend check during a run (task C07, D-08 C07 AC2, D-02 FR-52, design/ADR-M34 §2.6).
//
// The runner reads the spend of the run's key with the key itself (`RunKeySpendReader`, LiteLLM
// `/key/info`); it never holds the master key. Shares are of the key's cap, which the Cost
// Controller set to the smallest of the run budget, what is left of the intent budget and what is
// left of the tenant's month (ADR-M24): the contract's `max_budget_usd` only when the gateway does
// not report a cap.
// - At `budget.warn_percent`: the run event `budget_warning`, once per run (the comment on the
//   issue comes with G5, PR 2).
// - At `budget.stop_percent`: the runner stops the agent like at the time cap; the run ends
//   `stopped_budget` with `stop_reason` `max_budget`.
// LiteLLM itself refuses calls once the key's cap is reached; the agent then ends with an error.
// LiteLLM also records the spend `/key/info` shows in batches (about 10 s), so before such an error becomes `failed`, the caller
// reads the spend again after a short, bounded wait (`settleAfterError`): a real budget stop is
// never escalated as a technical failure.
// A read that fails counts as unknown: the gateway's own cap is the backstop.
import type { RedactedSecret, RunKeySpendReader } from '@sdlc/contracts';
import { toMicros } from '@sdlc/core';

export interface SpendLimits {
  readonly warnPercent: number;
  readonly stopPercent: number;
}

export type SpendState = 'ok' | 'stop' | 'unknown';

export interface BudgetWarning {
  readonly spend_usd: string;
  readonly max_budget_usd: string;
  readonly percent: number;
}

export class SpendWatch {
  readonly #reader: RunKeySpendReader;
  readonly #key: RedactedSecret;
  readonly #contractCapUsd: string;
  readonly #limits: SpendLimits;
  readonly #onWarning: (warning: BudgetWarning) => Promise<void>;
  #warned = false;

  constructor(options: {
    readonly reader: RunKeySpendReader;
    readonly key: RedactedSecret;
    readonly contractCapUsd: string;
    readonly limits: SpendLimits;
    readonly onWarning: (warning: BudgetWarning) => Promise<void>;
  }) {
    this.#reader = options.reader;
    this.#key = options.key;
    this.#contractCapUsd = options.contractCapUsd;
    this.#limits = options.limits;
    this.#onWarning = options.onWarning;
  }

  /** Reads the spend once; records the warning the first time its share is reached. */
  async check(): Promise<SpendState> {
    let spendUsd: string;
    let capUsd: string;
    try {
      const info = await this.#reader.readOwnSpend(this.#key);
      spendUsd = info.spendUsd;
      capUsd = info.maxBudgetUsd ?? this.#contractCapUsd;
    } catch {
      return 'unknown';
    }
    const cap = toMicros(capUsd);
    if (cap <= 0n) return 'unknown';
    const percent = Number((toMicros(spendUsd) * 100n) / cap);
    if (!this.#warned && percent >= this.#limits.warnPercent) {
      this.#warned = true;
      // The warning is advisory: a failed write must never abort the run without stopping it.
      await this.#onWarning({ spend_usd: spendUsd, max_budget_usd: capUsd, percent }).catch(
        () => undefined,
      );
    }
    return percent >= this.#limits.stopPercent ? 'stop' : 'ok';
  }

  /**
   * After the agent ended with an error: was it the budget? Reads now, and once more after `waitMs`
   * when the first read is below the stop share or unknown (LiteLLM records spend late).
   */
  async settleAfterError(sleep: (ms: number) => Promise<void>, waitMs: number): Promise<boolean> {
    if ((await this.check()) === 'stop') return true;
    await sleep(waitMs);
    return (await this.check()) === 'stop';
  }
}
