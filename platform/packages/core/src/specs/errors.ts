// Refusals of spec linking (task B08, design/ADR-M39 §2.2). Like `AiRecordError`, they carry a
// stable `code`; the API and the CLI render codes through the message catalog (`spec.error.<code>`).
import type { GitHostErrorCode } from '@sdlc/contracts';
import { t, type MessageKey } from '@sdlc/messages';

import type { SpecUnreadableCause } from './rules.js';

export type SpecErrorCode =
  /** The path is not a safe relative path to a Markdown file. */
  | 'invalid_path'
  /** The intent is not in a state that takes a spec (draft, or waiting at G1–G4). */
  | 'link_not_allowed'
  /** The file cannot be read at the commit (`cause`: missing, not a file, too large, not UTF-8). */
  | 'spec_unreadable'
  /** The file at the given commit differs from the file at the head of the default branch. */
  | 'not_on_default_branch'
  /** The project's repository name is not `owner/name`. */
  | 'repository_invalid'
  /** The Git host could not be read (`gitHostCode`); nothing was linked. */
  | 'git_host_unavailable';

export class SpecError extends Error {
  override readonly name = 'SpecError';

  constructor(
    readonly code: SpecErrorCode,
    message: string,
    readonly cause_?: SpecUnreadableCause,
    readonly gitHostCode?: GitHostErrorCode,
  ) {
    super(message);
  }
}

/** Catalog keys of the refusals (NFR-08). Parameter: `cause`. */
export const SPEC_ERROR_MESSAGES = {
  invalid_path: 'spec.error.invalid_path',
  link_not_allowed: 'spec.error.link_not_allowed',
  spec_unreadable: 'spec.error.spec_unreadable',
  not_on_default_branch: 'spec.error.not_on_default_branch',
  repository_invalid: 'spec.error.repository_invalid',
  git_host_unavailable: 'spec.error.git_host_unavailable',
} as const satisfies Record<SpecErrorCode, MessageKey>;

export function specErrorMessage(error: SpecError, locale?: string): string {
  return t(SPEC_ERROR_MESSAGES[error.code], { cause: error.cause_ ?? '-' }, locale);
}
