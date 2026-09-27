// Shared command handlers for the API (B03), comment commands (B06) and the workflow (B07).
export { projectAccess, type ProjectAccess } from './access.js';
export { CommandError, type CommandErrorCode } from './errors.js';
export {
  COMMAND_DECISIONS,
  decideGate,
  type CommandDecision,
  type GateCommand,
} from './gate-command.js';
export {
  COMMAND_GATES,
  gateInputSha256,
  intentInputSha256,
  isCommandGate,
  type CommandGate,
} from './gate-input.js';
