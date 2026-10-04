// JSON of the cost report (task E04, ADR-M45 §2.4). Codes, times, digit strings and decimal
// strings only: money is never a JSON number (D-05 D6), token sums are strings of digits.
import type { CostAmounts, CostReport } from '@sdlc/core';

function amounts(a: CostAmounts): Record<string, unknown> {
  return {
    calls: a.calls,
    input_tokens: a.inputTokens,
    output_tokens: a.outputTokens,
    cached_input_tokens: a.cachedInputTokens,
    cost_usd: a.costUsd,
    wasted_tokens: a.wastedTokens,
    wasted_cost_usd: a.wastedCostUsd,
  };
}

export function presentCostReport(report: CostReport): Record<string, unknown> {
  return {
    report: {
      scope: report.scope,
      from: report.from.toISOString(),
      to: report.to.toISOString(),
      group_by: report.groupBy,
      totals: amounts(report.totals),
      rows: report.rows.map((row) => ({ key: row.key, ...amounts(row) })),
      truncated: report.truncated,
      freshness: {
        latest_call_at: report.freshness.latestCallAt?.toISOString() ?? null,
        last_recorded_at: report.freshness.lastRecordedAt?.toISOString() ?? null,
        runs_in_progress: report.freshness.runsInProgress,
      },
    },
  };
}
