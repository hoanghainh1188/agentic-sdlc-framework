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
