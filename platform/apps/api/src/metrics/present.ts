// JSON of the gate waiting-time metrics (task E06, ADR-M47). Codes, times and whole seconds only;
// never a person. The two groups of finished waits stay apart (QUESTIONS #205).
import type { GateMetrics, WaitStats } from '@sdlc/core';

function waits(s: WaitStats): Record<string, unknown> {
  return {
    count: s.count,
    avg_seconds: s.avgSeconds,
    max_seconds: s.maxSeconds,
    p50_seconds: s.p50Seconds,
    p90_seconds: s.p90Seconds,
  };
}

export function presentGateMetrics(m: GateMetrics): Record<string, unknown> {
  return {
    metrics: {
      scope: m.scope,
      from: m.from.toISOString(),
      to: m.to.toISOString(),
      as_of: m.asOf.toISOString(),
      clock: 'wall_clock',
      filters: { gate: m.filters.gate, mode: m.filters.mode, risk: m.filters.riskTier },
      rows: m.rows.map((row) => ({
        project: row.project,
        gate: row.gate,
        first_round: waits(row.firstRound),
        after_changes: waits(row.afterChanges),
        auto_passed: row.autoPassed,
        open: { count: row.open.count, oldest_seconds: row.open.oldestSeconds },
      })),
      truncated: m.truncated,
    },
  };
}
