// One handler for Git host events, whether they come from polling (B06) or, later, webhooks
// (ADR-M11, design/ADR-M27 section 2.2). It turns comment commands into gate decisions through
// the same `decideGate` as the API (ADR-M26 section 2.4), so both paths apply the same rules.
//
// - Idempotent by `event.id`: a receipt (`git_event_receipts`) is written in the caller's
//   transaction; an event that already has one is skipped.
// - Only newly created comments are events (QUESTIONS.md #43; the adapter drops edits).
// - Actors are mapped by the numeric account ID, never by the login; bots never decide
//   (QUESTIONS.md #45).
// - No text from the Git host is stored: the receipt and the decision hold codes, IDs and the
//   comment URL (`reason_ref`) only.
import type { CommentCreatedEvent, GitEvent } from '@sdlc/contracts';

import { DbError } from '../db/errors.js';
import type { GitEventReceipt } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import type { GitProvider } from '../db/vocabulary.js';
import { RegistryError } from '../registry/errors.js';
import type { Registry } from '../registry/registry.js';
import { parseCommentCommand, type CommentSyntaxProblem } from './comment-command.js';
import { CommandError } from './errors.js';
import { decideGate } from './gate-command.js';

/** What happened to an event. Stored as `git_event_receipts.outcome` for command comments. */
export type GitEventOutcome =
  /** The gate decision was recorded. No reply: B07's status comment confirms it (FR-22). */
  | 'decided'
  /** The command was understood but refused (permission, gate, input); a reply says why. */
  | 'refused'
  /** The command could not be read; a reply shows the syntax. */
  | 'syntax_error'
  /** The Git host account is not linked to an active platform user. */
  | 'user_not_linked'
  /** No open intent is linked to this issue or pull request. */
  | 'intent_not_linked'
  /** More than one open intent is linked to it (QUESTIONS.md #68). */
  | 'intent_ambiguous'
  /** A bot wrote the command: bots never decide. No reply, so replies never loop. */
  | 'ignored_bot'
  /** The platform could not record the command (a stored value was refused). */
  | 'failed'
  /** Not stored: the event already has a receipt. */
  | 'duplicate'
  /** Not stored: a comment that is not a command of the platform. */
  | 'not_a_command'
  /** Not stored: reviews and checks are read by later gates (E01, C08). */
  | 'not_handled';

/** Codes of the reply comments. Each has the catalog key `comment.reply.<code>` (ADR-M27). */
export const COMMENT_REPLY_CODES = [
  'syntax_gate_missing',
  'syntax_gate_invalid',
  'syntax_unexpected_text',
  'syntax_reason_missing',
  'user_not_linked',
  'intent_not_linked',
  'intent_ambiguous',
  'intent_not_found',
  'forbidden',
  'gate_not_supported',
  'gate_input_missing',
  'approval_refused',
  'decision_not_allowed',
  'project_not_active',
  'config_invalid',
  'failed',
] as const;
export type CommentReplyCode = (typeof COMMENT_REPLY_CODES)[number];

export interface GitEventProject {
  readonly id: string;
  readonly provider: GitProvider;
}

export interface GitEventHandlerDeps {
  /** The registry with the apps' policy factory (`createSimplePolicyEngine`). */
  readonly registry: Registry;
}

export interface HandledGitEvent {
  readonly outcome: GitEventOutcome;
  /** The receipt written for this event; undefined for outcomes that store none. */
  readonly receipt?: GitEventReceipt;
}

const REASON_REF = /^https:\/\/[^\s]{1,504}$/;

interface Reply {
  readonly code: CommentReplyCode;
  readonly params: Readonly<Record<string, string>>;
}

const SYNTAX_REPLY: Readonly<Record<CommentSyntaxProblem, CommentReplyCode>> = {
  gate_missing: 'syntax_gate_missing',
  gate_invalid: 'syntax_gate_invalid',
  unexpected_text: 'syntax_unexpected_text',
  reason_missing: 'syntax_reason_missing',
};

/**
 * Handles one event in the scope's transaction (one is opened when the scope has none). Throws
 * only for errors that should stop the whole poll (for example a lost database connection), so
 * the batch is rolled back and read again.
 */
export function handleGitEvent(
  scope: TenantScope,
  deps: GitEventHandlerDeps,
  project: GitEventProject,
  event: GitEvent,
): Promise<HandledGitEvent> {
  if (event.kind !== 'comment_created') return Promise.resolve({ outcome: 'not_handled' });
  const command = parseCommentCommand(event.body);
  if (command.kind === 'none') return Promise.resolve({ outcome: 'not_a_command' });

  return scope.transaction(async (tx) => {
    if (await tx.gitEventReceipts.find(project.id, event.id)) return { outcome: 'duplicate' };
    const record = async (
      outcome: GitEventOutcome,
      extra: { gateDecisionId?: string; reply?: Reply } = {},
    ): Promise<HandledGitEvent> => ({
      outcome,
      receipt: await tx.gitEventReceipts.record({
        projectId: project.id,
        eventId: event.id,
        outcome,
        issueNumber: event.issueNumber,
        gateDecisionId: extra.gateDecisionId ?? null,
        ...(extra.reply ? { reply: extra.reply } : {}),
      }),
    });

    if (event.author.type === 'bot') return record('ignored_bot');
    if (command.kind === 'invalid') {
      return record('syntax_error', { reply: { code: SYNTAX_REPLY[command.problem], params: {} } });
    }
    const gate = { gate: command.gate };

    const actorId = await linkedUser(tx, project.provider, event);
    if (actorId === undefined) {
      return record('user_not_linked', { reply: { code: 'user_not_linked', params: gate } });
    }
    const intents = await tx.intents.findOpenByGitNumber(project.id, {
      kind: event.isPullRequest ? 'pull_request' : 'issue',
      number: event.issueNumber,
    });
    if (intents.length !== 1) {
      const code = intents.length === 0 ? 'intent_not_linked' : 'intent_ambiguous';
      return record(code, { reply: { code, params: gate } });
    }

    try {
      const decision = await tx.savepoint((sp) =>
        decideGate(deps.registry, sp, {
          intent: intents[0]!,
          gate: command.gate,
          decision: command.decision,
          actorId,
          reasonCode: command.reasonCode,
          reasonRef: REASON_REF.test(event.url) ? event.url : null,
          source: 'github_comment',
          eventSource: event.source,
        }),
      );
      return await record('decided', { gateDecisionId: decision.id });
    } catch (error) {
      const refusal = refusalReply(error, gate);
      if (refusal === undefined) throw error;
      return record(refusal.code === 'failed' ? 'failed' : 'refused', { reply: refusal });
    }
  });
}

/** The active platform user linked to the comment author, by numeric account ID only. */
async function linkedUser(
  scope: TenantScope,
  provider: GitProvider,
  event: CommentCreatedEvent,
): Promise<string | undefined> {
  const identity = await scope.userIdentities.findByExternalId(provider, event.author.id);
  if (!identity) return undefined;
  const user = await scope.users.getById(identity.user_id);
  return user?.status === 'active' ? user.id : undefined;
}

/** The reply for an expected refusal; undefined for errors that must stop the poll. */
function refusalReply(error: unknown, gate: Readonly<{ gate: string }>): Reply | undefined {
  if (error instanceof CommandError) {
    // `project_not_found` cannot happen here (the project is the polled one); same text as no role.
    const code = error.code === 'project_not_found' ? 'intent_not_found' : error.code;
    return { code, params: gate };
  }
  if (error instanceof RegistryError) {
    const code = error.code === 'config_hash_mismatch' ? 'config_invalid' : error.code;
    return { code, params: error.reason ? { ...gate, reason: error.reason } : gate };
  }
  // A value the database refused (for example a constraint): retrying the poll would fail the
  // same way and block every later event of the project, so it is answered, not retried.
  if (
    error instanceof DbError &&
    (error.code === 'invalid_value' || error.code === 'reference_not_found')
  ) {
    return { code: 'failed', params: gate };
  }
  return undefined;
}
