// Texts of agent errors (NFR-08, ADR-M18). The adapter does not import the message catalog: it
// throws `AgentError` with a code, and the runner renders it here (like GIT_HOST_ERROR_MESSAGES).
import type { AgentError, AgentErrorCode } from '@sdlc/contracts';
import { t, type MessageKey } from '@sdlc/messages';

export const AGENT_ERROR_MESSAGES = {
  invalid_input: 'agent.error.invalid_input',
  model_not_allowed: 'agent.error.model_not_allowed',
  tool_not_allowed: 'agent.error.tool_not_allowed',
  unauthorized: 'agent.error.unauthorized',
  not_found: 'agent.error.not_found',
  server_error: 'agent.error.server_error',
  network_error: 'agent.error.network_error',
  timeout: 'agent.error.timeout',
  invalid_response: 'agent.error.invalid_response',
  branch_changed: 'agent.error.branch_changed',
  git_failed: 'agent.error.git_failed',
} as const satisfies Record<AgentErrorCode, MessageKey>;

/** The text of an agent error. Missing parameters render as empty text, never as `{name}`. */
export function agentErrorMessage(error: AgentError, locale?: string): string {
  const params = { field: '', tool: '', status: '', exit_code: '', ...error.params };
  return t(AGENT_ERROR_MESSAGES[error.code], params, locale);
}
