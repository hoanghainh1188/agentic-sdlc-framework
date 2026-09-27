// The intent workflow's database side (task B07, design/ADR-M30). Temporal lives in the worker.
export { gateHistory, type GateHistory } from './gate-history.js';
export {
  FINISHED_INTENT_STATUSES,
  stepIntent,
  waitedSeconds,
  WorkflowError,
  type StepDeps,
} from './step.js';
export {
  blockWindowEnd,
  hotlBlockWindowOpenUntil,
  openBlockWindow,
  type EarlierBlock,
  type PassedGate,
} from './hotl.js';
export { closeGateOverdue, gateDeadline, overdueRoute } from './overdue.js';
