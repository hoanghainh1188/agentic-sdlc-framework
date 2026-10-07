// Money, tokens and shares for the cost and gate-time screens. Money stays a decimal string (D-05
// D6): rounding for display works on the digits, never on a float.
import type { CostReportView, GateMetricsView } from '@sdlc/api-schemas';

/** `"12.345678"` → `"12.35"` (half up), for display only. */
export function roundUsd(value: string, decimals = 2): string {
  const match = /^([0-9]+)(?:\.([0-9]*))?$/.exec(value);
  if (!match) return value;
  const whole = match[1] ?? '0';
  const fraction = (match[2] ?? '').padEnd(decimals + 1, '0');
  let digits = BigInt(whole + fraction.slice(0, decimals));
  if (Number(fraction[decimals]) >= 5) digits += 1n;
  const text = digits.toString().padStart(decimals + 1, '0');
  const intPart = text.slice(0, text.length - decimals);
  return decimals === 0 ? intPart : `${intPart}.${text.slice(text.length - decimals)}`;
}

/** Digits with thousands separators; works for token sums beyond 2^53. */
export function groupDigits(value: string, locale = 'en'): string {
  return /^[0-9]+$/.test(value) ? new Intl.NumberFormat(locale).format(BigInt(value)) : value;
}

/** A share between 0 and 1 for a bar; display only, so a float is fine here. */
export function share(part: string, total: string): number {
  const p = Number(part);
  const t = Number(total);
  return t > 0 && Number.isFinite(p) ? Math.min(1, Math.max(0, p / t)) : 0;
}

export interface CostBar {
  readonly key: string | null;
  readonly costUsd: string;
  readonly wastedUsd: string;
  readonly calls: number;
  readonly tokens: string;
  readonly costShare: number;
  readonly wastedShare: number;
}

/** Rows by cost, largest first; shares against the largest row, so the top bar is full. */
export function costBars(report: CostReportView): readonly CostBar[] {
  const rows = [...report.rows].sort((a, b) => Number(b.cost_usd) - Number(a.cost_usd));
  const top = rows[0]?.cost_usd ?? '0';
  return rows.map((row) => ({
    key: row.key,
    costUsd: row.cost_usd,
    wastedUsd: row.wasted_cost_usd,
    calls: row.calls,
    tokens: (BigInt(row.input_tokens) + BigInt(row.output_tokens)).toString(),
    costShare: share(row.cost_usd, top),
    wastedShare: share(row.wasted_cost_usd, top),
  }));
}

export interface GateWaitBar {
  readonly project: string;
  readonly gate: string;
  readonly decided: number;
  readonly avgSeconds: number | null;
  readonly p90Seconds: number | null;
  readonly maxSeconds: number | null;
  readonly openCount: number;
  readonly oldestOpenSeconds: number | null;
  readonly autoPassed: number;
}

/** One bar per gate and project, from the first round of decisions (E06, ADR-M47). */
export function gateWaitBars(metrics: GateMetricsView): readonly GateWaitBar[] {
  return metrics.rows.map((row) => ({
    project: row.project,
    gate: row.gate,
    decided: row.first_round.count + row.after_changes.count,
    avgSeconds: row.first_round.avg_seconds,
    p90Seconds: row.first_round.p90_seconds,
    maxSeconds:
      Math.max(row.first_round.max_seconds ?? 0, row.after_changes.max_seconds ?? 0) || null,
    openCount: row.open.count,
    oldestOpenSeconds: row.open.oldest_seconds,
    autoPassed: row.auto_passed,
  }));
}

/** The scale of the gate-time chart: the largest value any bar shows. */
export function waitScale(bars: readonly GateWaitBar[]): number {
  return Math.max(
    1,
    ...bars.flatMap((b) => [b.maxSeconds ?? 0, b.oldestOpenSeconds ?? 0, b.p90Seconds ?? 0]),
  );
}
