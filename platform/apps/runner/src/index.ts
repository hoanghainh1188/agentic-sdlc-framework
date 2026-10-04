// Runner: provisions sandboxes and runs the agent. See design/D-03 section 5.1 and ADR-M25.
export { ALLOWED_ENDPOINTS, DockerClient, isAllowedEndpoint } from './docker/client.js';
export type {
  ContainerInfo,
  DockerClientOptions,
  NetworkSpec,
  NetworkSummary,
} from './docker/client.js';
export {
  assertSafeContainerSpec,
  assertSafeNetworkSpec,
  SANDBOX_ENV_ALLOWLIST,
  type ContainerSpec,
} from './docker/guard.js';
export { agentUrl, attachRunner } from './agent/access.js';
export {
  AGENT_WORKING_DIR,
  agentCommitAuthor,
  driveAgent,
  llmReachable,
  outcomeOf,
  type AgentDriveDeps,
  type AgentOutcome,
  type AgentRunRequest,
  type AgentRunResult,
} from './agent/drive.js';
export { AgentRunError, type AgentRunFailure } from './agent/errors.js';
export {
  LoopWatch,
  type LoopLimits,
  type LoopStop,
  type LoopStopReason,
} from './agent/loop-watch.js';
export {
  SpendWatch,
  type BudgetWarning,
  type SpendLimits,
  type SpendState,
} from './agent/spend.js';
export { AGENT_ERROR_MESSAGES, agentErrorMessage } from './agent/messages.js';
export {
  loadAgentTask,
  PLAN_FIELD_MAX_CHARS,
  PLAN_TASK_TEXT_MAX_CHARS,
  renderPlanTasks,
} from './agent/task.js';
export { capText, cleanText } from './agent/text.js';
export {
  capFeedback,
  readRunFeedback,
  REVIEW_FEEDBACK_MAX_CHARS,
  type FeedbackAccess,
  type FeedbackReader,
} from './agent/feedback.js';
export { assertSafeNetworkConnect } from './docker/guard.js';
export { RunnerError, type RunnerErrorKey } from './errors.js';
export { HeldRuns } from './held.js';
export {
  recordWrapTokenReused,
  revokeAfterUse,
  type GitTokenRevoker,
  type RunToken,
} from './tokens.js';
export {
  isRunId,
  LABELS,
  MANAGED_BY,
  runLabels,
  runNames,
  runOfLabels,
  type LabelledRun,
  type RunNames,
} from './names.js';
export { SlotPool, type Slot } from './pool.js';
export {
  DB_PASSWORD_FIELD,
  DB_USER,
  PROCESS_ENV,
  processSettingsFromEnv,
  type ProcessSettings,
} from './process.js';
export {
  findRunObjects,
  reconcileOnStart,
  sweepOrphans,
  type ReconcileDeps,
  type ReconcileResult,
} from './reconcile.js';
export { Runner, type RunnerAgentOptions, type RunnerHooks } from './runner.js';
export {
  createSandbox,
  ProvisioningError,
  releaseWorkspace,
  reserveWorkspace,
  teardownSandbox,
  type CreateSandboxInput,
  type ProvisioningFailure,
  type Sandbox,
  type TeardownReason,
  type TeardownResult,
} from './sandbox/lifecycle.js';
export { planEgress, runNetworkSpec, type EgressPlan } from './sandbox/network.js';
export { buildSandboxSpec, type SandboxSpecInput } from './sandbox/spec.js';
export {
  releaseSandbox,
  provisionRun,
  type ProvisionRequest,
  type ProvisionResult,
  type RunnerDeps,
} from './provision.js';
export {
  authEnv,
  CloneError,
  cloneForPush,
  cloneForRun,
  cloneUrl,
  PushError,
  pushCommit,
  remoteBranchHead,
  type CloneFailure,
  type PushFailure,
  type CloneInput,
  type GitSettings,
} from './workspace/git.js';
export { packDirectory, packTar, SANDBOX_UID, type TarEntry } from './workspace/tar.js';
export {
  computeRunPatch,
  exportWorkspace,
  MAX_WORKSPACE_ENTRIES,
  storeProposal,
  type ProposalDeps,
  type StoredProposal,
} from './workspace/export.js';
export {
  checkChangedPaths,
  storeChanges,
  type ChangesDeps,
  type CheckedChanges,
} from './workspace/changes.js';
export { IgnoreChecker } from './workspace/ignore.js';
export {
  planFileReader,
  readPlanBlob,
  type PlanBlobFailure,
  type PlanBlobRead,
  type PlanFileReader,
} from './workspace/plan-file.js';
export {
  publishRun,
  type PublishDeps,
  type PublishFailure,
  type PublishRefusal,
} from './workspace/publish.js';
export {
  computeProposal,
  mirrorWorkspace,
  neutraliseAttributes,
  type Proposal,
  type ProposalGitOptions,
} from './workspace/proposal.js';
export {
  untarWorkspace,
  type EntryDecision,
  type EntryFilter,
  type UntarLimits,
  type WorkspaceEntry,
} from './workspace/untar.js';
export {
  parseEgressServices,
  RUNNER_ENV,
  runnerSettingsFromEnv,
  type AgentSettings,
  type EgressService,
  type RunnerSettings,
  type SandboxLimits,
} from './settings.js';
