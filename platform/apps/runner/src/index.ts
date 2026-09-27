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
export { RunnerError, type RunnerErrorKey } from './errors.js';
export { HeldRuns } from './held.js';
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
export { Runner, type RunnerHooks } from './runner.js';
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
  cloneForRun,
  cloneUrl,
  type CloneFailure,
  type CloneInput,
  type GitSettings,
} from './workspace/git.js';
export { packDirectory, packTar, SANDBOX_UID, type TarEntry } from './workspace/tar.js';
export {
  parseEgressServices,
  RUNNER_ENV,
  runnerSettingsFromEnv,
  type EgressService,
  type RunnerSettings,
  type SandboxLimits,
} from './settings.js';
