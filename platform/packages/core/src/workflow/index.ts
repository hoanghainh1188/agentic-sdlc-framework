// The intent workflow's database side (task B07, design/ADR-M30). Temporal lives in the worker.
export { gateHistory, type GateHistory } from './gate-history.js';
export { FINISHED_INTENT_STATUSES, stepIntent, WorkflowError, type StepDeps } from './step.js';
