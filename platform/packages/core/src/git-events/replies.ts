// Reply comments of the GitHub poller (D-08 B06 AC4, design/ADR-M27 section 2.4). The receipt
// stores a reply code and code parameters; the text is rendered here from the message catalog when
// the reply is posted (NFR-08). Never text from the Git host.
import { GATE_REASON_CODES } from '@sdlc/contracts';
import { t, type MessageKey } from '@sdlc/messages';

import { COMMENT_REPLY_CODES, type CommentReplyCode } from '../commands/git-event-handler.js';
import { isRefusalReason, refusalReasonMessage } from '../commands/refusal-messages.js';

/** Catalog key of each reply code (tested: every code has one). */
export const COMMENT_REPLY_KEYS: Readonly<Record<CommentReplyCode, MessageKey>> = {
  syntax_gate_missing: 'comment.reply.syntax_gate_missing',
  syntax_gate_invalid: 'comment.reply.syntax_gate_invalid',
  syntax_unexpected_text: 'comment.reply.syntax_unexpected_text',
  syntax_reason_missing: 'comment.reply.syntax_reason_missing',
  user_not_linked: 'comment.reply.user_not_linked',
  intent_not_linked: 'comment.reply.intent_not_linked',
  intent_ambiguous: 'comment.reply.intent_ambiguous',
  intent_not_found: 'comment.reply.intent_not_found',
  forbidden: 'comment.reply.forbidden',
  gate_not_supported: 'comment.reply.gate_not_supported',
  gate_input_missing: 'comment.reply.gate_input_missing',
  approval_refused: 'comment.reply.approval_refused',
  decision_not_allowed: 'comment.reply.decision_not_allowed',
  project_not_active: 'comment.reply.project_not_active',
  config_invalid: 'comment.reply.config_invalid',
  failed: 'comment.reply.failed',
};

function isReplyCode(code: string): code is CommentReplyCode {
  return (COMMENT_REPLY_CODES as readonly string[]).includes(code);
}

/**
 * The Markdown body of a reply. Syntax replies end with the command syntax and the list of valid
 * reason codes. A hidden marker names the event, so a person can trace a reply to its receipt.
 */
export function renderCommentReply(
  code: string,
  params: Readonly<Record<string, string>>,
  eventId: string,
  locale?: string,
): string {
  // A code from a newer version of the platform (rolled back since): answer generically.
  const key = isReplyCode(code) ? COMMENT_REPLY_KEYS[code] : COMMENT_REPLY_KEYS.failed;
  const parts = [t(key, { gate: params.gate ?? '' }, locale)];
  // Known reason codes only: the text of an unknown code is never echoed into a comment.
  if (params.reason !== undefined && isRefusalReason(params.reason)) {
    parts.push(
      t('comment.reply.reason', { reason: refusalReasonMessage(params.reason, locale) }, locale),
    );
  }
  if (code.startsWith('syntax_')) {
    parts.push(t('comment.reply.usage', { codes: GATE_REASON_CODES.join(', ') }, locale));
  }
  parts.push(t('comment.reply.footer', {}, locale));
  return `${parts.join('\n\n')}\n\n<!-- sdlc-reply ${eventId} -->`;
}
