// Process metrics (task E06, D-02 FR-12, design/ADR-M47).
export {
  GATE_METRICS_DEFAULT_DAYS,
  GATE_METRICS_MAX_ROWS,
  buildGateMetrics,
  checkGateMetricsRange,
  mergeGateMetrics,
  resolveGateMetricsRange,
  type GateMetrics,
  type GateMetricsInput,
  type GateMetricsRange,
  type GateMetricsRow,
  type GateMetricsScope,
  type WaitStats,
} from './gates.js';
