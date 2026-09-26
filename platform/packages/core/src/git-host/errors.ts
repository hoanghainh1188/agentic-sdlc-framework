// Texts of Git host errors (NFR-08, ADR-M18). Adapters do not import the message catalog: they
// throw `GitHostError` with a code, and the apps render it here (design/ADR-M23 §2.6).
import type { GitHostError, GitHostErrorCode } from '@sdlc/contracts';
import { t, type MessageKey } from '@sdlc/messages';

export const GIT_HOST_ERROR_MESSAGES = {
  invalid_input: 'git_host.error.invalid_input',
  secret_invalid: 'git_host.error.secret_invalid',
  auth_failed: 'git_host.error.auth_failed',
  app_not_installed: 'git_host.error.app_not_installed',
  forbidden: 'git_host.error.forbidden',
  not_found: 'git_host.error.not_found',
  rejected: 'git_host.error.rejected',
  rate_limited: 'git_host.error.rate_limited',
  server_error: 'git_host.error.server_error',
  network_error: 'git_host.error.network_error',
  timeout: 'git_host.error.timeout',
  invalid_response: 'git_host.error.invalid_response',
  invalid_cursor: 'git_host.error.invalid_cursor',
  body_too_large: 'git_host.error.body_too_large',
  file_too_large: 'git_host.error.file_too_large',
  file_not_utf8: 'git_host.error.file_not_utf8',
  not_a_file: 'git_host.error.not_a_file',
  too_many_files: 'git_host.error.too_many_files',
  webhook_disabled: 'git_host.error.webhook_disabled',
  webhook_bad_signature: 'git_host.error.webhook_bad_signature',
  unsupported_event: 'git_host.error.unsupported_event',
} as const satisfies Record<GitHostErrorCode, MessageKey>;

/** The text of a Git host error. Missing parameters render as empty text, never as `{name}`. */
export function gitHostErrorMessage(error: GitHostError, locale?: string): string {
  const params = { field: '', path: '', repo: '', status: '', ...error.params };
  return t(GIT_HOST_ERROR_MESSAGES[error.code], params, locale);
}
