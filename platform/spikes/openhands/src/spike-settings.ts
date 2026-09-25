// Settings of the C01 spike. Handbook rules come from project config (@sdlc/config); values that
// have no config key yet are labelled spike defaults (QUESTIONS.md #13: C05 adds them to config).
import { defaultProjectConfig } from '@sdlc/config';

export interface SpikeSettings {
  /** From config `run.loop_detection.identical_tool_calls_max` (handbook Ch.3 §3.6). */
  identicalToolCallsMax: number;
  /** From config `run.loop_detection.no_progress_window_minutes`. */
  noProgressWindowMinutes: number;
  /** From config `budget.default_run_usd` (D-07 §6). */
  defaultRunBudgetUsd: number;
  /** From config `budget.warn_percent`. */
  budgetWarnPercent: number;
  /** Spike default. C05 moves it to config as `run.default_max_iterations` (QUESTIONS.md #13). */
  maxIterations: number;
  /** Spike default. C05 moves it to config as `run.default_max_duration_minutes` (QUESTIONS.md #13). */
  maxDurationMinutes: number;
  /** Spike default: lifetime of the per-run virtual key. */
  keyDurationMinutes: number;
  /** Cap for the one real-model run, set by Harry (2026-09-25): USD 1.00 in total. */
  realRunCapUsd: number;
}

export const SPIKE_DEFAULTS = {
  maxIterations: 30,
  maxDurationMinutes: 10,
  keyDurationMinutes: 30,
  realRunCapUsd: 1.0,
} as const;

export function loadSpikeSettings(): SpikeSettings {
  const config = defaultProjectConfig();
  return {
    identicalToolCallsMax: config.run.loop_detection.identical_tool_calls_max,
    noProgressWindowMinutes: config.run.loop_detection.no_progress_window_minutes,
    defaultRunBudgetUsd: config.budget.default_run_usd,
    budgetWarnPercent: config.budget.warn_percent,
    ...SPIKE_DEFAULTS,
  };
}

/** Budget of the real-model key: the config run budget, never above Harry's cap. */
export function realRunBudgetUsd(settings: SpikeSettings): number {
  return Math.min(settings.defaultRunBudgetUsd, settings.realRunCapUsd);
}
