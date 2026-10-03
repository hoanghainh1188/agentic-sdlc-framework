// The intent workflow's database side (task B07, design/ADR-M30). Temporal lives in the worker.
export { gateHistory, type GateHistory } from './gate-history.js';
export {
  FINISHED_INTENT_STATUSES,
  GIT_HOST_RETRY_MS,
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
export { closeGateOverdue, gateDeadline, overdueRoute, type HumanGate } from './overdue.js';
export {
  gatherG4Facts,
  latestRunProposalSha256,
  projectRepoRef,
  runProposalSha256,
  type G4Deps,
  type G4Facts,
  type RunProposal,
} from './g4-proposal.js';
export {
  effectiveAutonomy,
  evaluateG4,
  g4Decided,
  G4_OPERATOR_ROLES,
  stepG4,
  type G4Decided,
  type G4Evaluation,
  type G4Policy,
  type G4StepOutcome,
} from './g4.js';
export {
  prepareRun,
  type PrepareRunDeps,
  type PrepareRunRefusal,
  type PrepareRunResult,
  type PreparedRun,
} from './prepare-run.js';
export {
  abandonRun,
  CONTRACT_EXPIRED,
  finishRun,
  RUNNER_LOST,
  startRun,
  stepPaused,
  stepRunning,
  type RunDeps,
} from './run-lifecycle.js';
export { isFinalRun, roundRuns } from './run-round.js';
export {
  checkSpec,
  gatherSpecFacts,
  isSpecCheckGate,
  SPEC_CHECK_GATES,
  type SpecCheckOutcome,
  type SpecFacts,
  type SpecHold,
} from './spec-check.js';
