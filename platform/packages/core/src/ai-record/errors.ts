// Refusals of the project AI record (task B12, design/ADR-M32). Like `AgentRegisterError`, they
// carry a stable `code`; the API and the CLI render codes through the message catalog
// (`ai_record.error.<code>`).
import { t, type MessageKey } from '@sdlc/messages';

import type { AiRecordViolation } from './rules.js';

export type AiRecordErrorCode =
  | AiRecordViolation
  /** The record changed since the version the caller read (compare-and-set). */
  | 'version_conflict'
  /** The named user holds none of the write roles of the project (`sdlc admin ai-record`). */
  | 'not_a_writer';

export class AiRecordError extends Error {
  override readonly name = 'AiRecordError';

  constructor(
    readonly code: AiRecordErrorCode,
    message: string,
    /** The field that failed (`invalid_input` only). */
    readonly field?: string,
  ) {
    super(message);
  }
}

/** Catalog keys of the refusals (NFR-08). Parameters: `field`. */
export const AI_RECORD_ERROR_MESSAGES = {
  invalid_input: 'ai_record.error.invalid_input',
  prohibited_class: 'ai_record.error.prohibited_class',
  client_class_without_ai: 'ai_record.error.client_class_without_ai',
  unconfirmed_confidential: 'ai_record.error.unconfirmed_confidential',
  confirmed_without_ref: 'ai_record.error.confirmed_without_ref',
  version_conflict: 'ai_record.error.version_conflict',
  not_a_writer: 'ai_record.error.not_a_writer',
} as const satisfies Record<AiRecordErrorCode, MessageKey>;

export function aiRecordErrorMessage(error: AiRecordError, locale?: string): string {
  return t(AI_RECORD_ERROR_MESSAGES[error.code], { field: error.field ?? '-' }, locale);
}
