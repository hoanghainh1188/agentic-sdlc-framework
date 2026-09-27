// The agent register (task C10, design/ADR-M31, handbook Ch.20).
export {
  AGENT_REGISTER_ERROR_MESSAGES,
  AgentRegisterError,
  agentRegisterErrorMessage,
  type AgentRegisterErrorCode,
} from './errors.js';
export {
  checkAgentForRun,
  instructionsPath,
  recertificationMonths,
  type AgentRunCheck,
  type AgentRunWarning,
  type CheckedAgent,
} from './check.js';
export {
  changeAgentOwner,
  changeAgentStatus,
  recertifyAgent,
  registerAgent,
  updateAgent,
  type ChangeAgentStatus,
  type RegisterAgent,
  type UpdateAgent,
} from './register.js';
export {
  addMonths,
  AGENT_CHANGEABLE_STATUSES,
  AGENT_STATUS_MOVES,
  AGENT_STATUS_REASONS,
  instructionsSha256,
  parseInstructionsRef,
  recertificationStatus,
  RUN_ENVIRONMENT,
  type AgentStatusReason,
  type RecertificationStatus,
} from './rules.js';
