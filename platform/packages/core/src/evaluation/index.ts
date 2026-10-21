// Evaluations on the server (task L04, design/ADR-M81).
export { EVALUATION_ERROR_CODES, EvaluationError, type EvaluationErrorCode } from './errors.js';
export {
  startEvaluation,
  type EvaluationPolicyFactory,
  type StartEvaluationDeps,
  type StartEvaluationInput,
} from './start.js';
export {
  EVALUATION_BUDGET_USED,
  evaluationBudget,
  nextRunKeyCap,
  stopEvaluationIfBudgetUsed,
  type EvaluationBudget,
} from './budget.js';
export {
  EVALUATION_CONTRACT_ERROR_CODES,
  EvaluationContractError,
  evaluationContractBytes,
  evaluationContractSha256,
  issueEvaluationContract,
  verifyEvaluationContract,
  type EvaluationContractErrorCode,
  type EvaluationContractVerification,
  type IssueEvaluationContract,
  type IssueEvaluationDeps,
  type IssuedEvaluationContract,
  type VerifyEvaluationDeps,
} from './contract.js';
export {
  MODEL_NOT_ALLOWED,
  TENANT_BUDGET_USED,
  prepareEvaluationRun,
  type PrepareEvaluationDeps,
  type PrepareEvaluationRefusal,
  type PrepareEvaluationResult,
  type PreparedEvaluationRun,
} from './prepare.js';
export {
  MAX_EVALUATION_ATTEMPTS,
  finishEvaluationRun,
  type EvaluationRunEnd,
  type FinishEvaluationDeps,
  type FinishEvaluationInput,
} from './finish.js';
export {
  MONTHLY_CAP_USED,
  archiveEvaluationPlan,
  assertEvalRole,
  changeEvaluationPlan,
  changedPlanFields,
  createEvaluationPlan,
  mayChangePlans,
  mayReadPlans,
  nextScheduledRun,
  planChangeNeedsStepUp,
  planFleetSha256,
  readEvaluationPlan,
  requestEvaluationPlanRun,
  resolveConfigurations,
  startEvaluationPlan,
  startOfNextUtcMonth,
  type EvaluationPlanDeps,
  type KnownTaskSet,
  type PlanActor,
  type PlanConfigurationInput,
  type PlanContentInput,
} from './plans.js';
export { checkEvaluationScope } from './start.js';
export { advanceEvaluationPlan, type PlanStep } from './plan-loop.js';
export {
  draftEvaluationTask,
  listEvaluationTasks,
  registerEvaluationTask,
  reviewEvaluationTask,
  type DraftEvaluationTaskInput,
  type EvaluationTaskDeps,
  type EvaluationTaskGitHost,
  type RegisterEvaluationTaskInput,
  type ReviewEvaluationTaskInput,
} from './tasks.js';
export {
  MAX_TASK_CHECK_ATTEMPTS,
  finishTaskCheck,
  prepareTaskCheck,
  taskCheckContractBytes,
  taskCheckContractSha256,
  verifyTaskCheckContract,
  type FinishTaskCheckInput,
  type PrepareTaskCheckResult,
  type TaskCheckContractVerification,
  type TaskCheckDeps,
  type VerifyTaskCheckDeps,
} from './task-check.js';
export {
  checkProjectTaskSet,
  readProjectTaskSet,
  type ProjectTaskSet,
} from './project-task-set.js';
export { toRunResult, type StoredResult } from './report-rows.js';
