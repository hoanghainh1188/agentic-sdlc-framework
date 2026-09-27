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
export { isRunId, LABELS, MANAGED_BY, runLabels, runNames, type RunNames } from './names.js';
export { SlotPool, type Slot } from './pool.js';
export {
  createSandbox,
  ProvisioningError,
  teardownSandbox,
  type CreateSandboxInput,
  type ProvisioningFailure,
  type Sandbox,
  type TeardownReason,
  type TeardownResult,
} from './sandbox/lifecycle.js';
export { planEgress, runNetworkSpec, type EgressPlan } from './sandbox/network.js';
export { buildSandboxSpec, type SandboxSpecInput } from './sandbox/spec.js';
export { packTar, SANDBOX_UID, type TarEntry } from './workspace/tar.js';
export {
  parseEgressServices,
  RUNNER_ENV,
  runnerSettingsFromEnv,
  type EgressService,
  type RunnerSettings,
  type SandboxLimits,
} from './settings.js';
