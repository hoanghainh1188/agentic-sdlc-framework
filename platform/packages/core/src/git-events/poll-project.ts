// One poll of one project (D-08 B06 AC1, design/ADR-M27 section 2.1). The worker's loop calls it
// on the project's interval (`github.poll_interval_seconds`).
//
// 1. Read the cursor and ask the Git host for the events since it (outside any transaction).
// 2. In ONE transaction: move the cursor with compare-and-set, then handle every event (gate
//    decisions, receipts). A crash before the commit applies nothing; a second poller that read
//    the same cursor finds it moved and rolls back. The receipts make the handler idempotent by
//    event ID as well (ADR-M23 §2.3: "preferably both").
// 3. After the commit, post the pending replies (at least once: a crash after the POST and before
//    the update posts that reply again on the next poll).
import {
  GitHostError,
  INITIAL_EVENT_CURSOR,
  type EventCursor,
  type GitHostAdapter,
  type RepoRef,
} from '@sdlc/contracts';

import {
  handleGitEvent,
  type GitEventOutcome,
  type GitEventHandlerDeps,
} from '../commands/git-event-handler.js';
import type { PollableProject } from '../db/system-scope.js';
import type { TenantId } from '../db/tenant-id.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { renderCommentReply } from './replies.js';

export type PollLogEvent =
  | 'poll.completed'
  | 'poll.cursor_moved'
  | 'poll.project_skipped'
  | 'poll.event_handled'
  | 'reply.posted'
  | 'reply.failed'
  | 'reply.abandoned';

/** Structured log hook. Fields hold IDs and codes only: never comment text or tokens. */
export interface PollLogger {
  log(
    level: 'info' | 'warn' | 'error',
    event: PollLogEvent,
    fields: Readonly<Record<string, string | number | boolean>>,
  ): void;
}

export interface PollDeps extends GitEventHandlerDeps {
  readonly db: { forTenant(tenantId: TenantId): TenantScope };
  readonly gitHost: GitHostAdapter;
  readonly now?: () => Date;
  readonly logger?: PollLogger;
  /** A reply is given up after this many failed posts. Default 5. */
  readonly maxReplyAttempts?: number;
  /** Replies posted per poll at most. Default 20. */
  readonly repliesPerPoll?: number;
}

export interface PollResult {
  /** `polled`: events handled and cursor stored; `cursor_moved`: another poller was first. */
  readonly status: 'polled' | 'cursor_moved' | 'skipped';
  readonly events: number;
  readonly outcomes: Readonly<Partial<Record<GitEventOutcome, number>>>;
  readonly repliesPosted: number;
  readonly repliesFailed: number;
}

class CursorMoved extends Error {
  override readonly name = 'CursorMoved';
}

const REPO_FULL_NAME = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;

function repoRef(fullName: string): RepoRef | undefined {
  const match = REPO_FULL_NAME.exec(fullName);
  return match ? { owner: match[1]!, name: match[2]! } : undefined;
}

export async function pollProject(deps: PollDeps, target: PollableProject): Promise<PollResult> {
  const now = deps.now ?? (() => new Date());
  const log = deps.logger ?? { log: () => undefined };
  const ids = { tenant_id: target.tenantId, project_id: target.projectId };
  const scope = deps.db.forTenant(target.tenantId);

  const project = await scope.projects.getById(target.projectId);
  const ref = project ? repoRef(project.repo_full_name) : undefined;
  if (!project || project.status !== 'active' || project.git_provider !== 'github' || !ref) {
    log.log('warn', 'poll.project_skipped', ids);
    return { status: 'skipped', events: 0, outcomes: {}, repliesPosted: 0, repliesFailed: 0 };
  }

  const stored = await scope.gitEventCursors.get(project.id);
  const expected = stored?.cursor ?? null;
  const { events, next } = await deps.gitHost.listEventsSince(
    ref,
    (expected ?? INITIAL_EVENT_CURSOR) as EventCursor,
  );

  let outcomes: Partial<Record<GitEventOutcome, number>> = {};
  let status: PollResult['status'] = 'polled';
  try {
    outcomes = await scope.transaction(async (tx) => {
      const counts: Partial<Record<GitEventOutcome, number>> = {};
      // First, so the cursor row stays locked for the whole batch.
      if (!(await tx.gitEventCursors.saveIfUnchanged(project.id, expected, next, now()))) {
        throw new CursorMoved();
      }
      for (const event of events) {
        const { outcome } = await handleGitEvent(
          tx,
          { registry: deps.registry },
          { id: project.id, provider: 'github' },
          event,
        );
        counts[outcome] = (counts[outcome] ?? 0) + 1;
        if (outcome !== 'not_a_command' && outcome !== 'not_handled') {
          log.log('info', 'poll.event_handled', { ...ids, event_id: event.id, outcome });
        }
      }
      return counts;
    });
  } catch (error) {
    if (!(error instanceof CursorMoved)) throw error;
    status = 'cursor_moved';
    log.log('warn', 'poll.cursor_moved', ids);
  }

  const replies = await flushReplies(deps, scope, project.id, ref, now);
  log.log('info', 'poll.completed', {
    ...ids,
    status,
    events: events.length,
    replies_posted: replies.posted,
    replies_failed: replies.failed,
  });
  return {
    status,
    events: status === 'polled' ? events.length : 0,
    outcomes,
    repliesPosted: replies.posted,
    repliesFailed: replies.failed,
  };
}

/** Posts the pending replies of a project (the outbox), oldest first. */
async function flushReplies(
  deps: PollDeps,
  scope: TenantScope,
  projectId: string,
  ref: RepoRef,
  now: () => Date,
): Promise<{ posted: number; failed: number }> {
  const log = deps.logger ?? { log: () => undefined };
  const maxAttempts = deps.maxReplyAttempts ?? 5;
  const pending = await scope.gitEventReceipts.pendingReplies(projectId, deps.repliesPerPoll ?? 20);
  let posted = 0;
  let failed = 0;
  for (const receipt of pending) {
    const fields = {
      tenant_id: scope.tenantId,
      project_id: projectId,
      event_id: receipt.event_id,
      reply: receipt.reply_code ?? '',
    };
    const attempts = receipt.reply_attempts + 1;
    try {
      await deps.gitHost.createIssueComment(
        ref,
        receipt.issue_number!,
        renderCommentReply(receipt.reply_code!, receipt.reply_params ?? {}, receipt.event_id),
      );
      await scope.gitEventReceipts.markReplyPosted(receipt.id, attempts, now());
      posted += 1;
      log.log('info', 'reply.posted', fields);
    } catch (error) {
      const code = error instanceof GitHostError ? error.code : 'unexpected';
      const abandon = attempts >= maxAttempts;
      await scope.gitEventReceipts.markReplyFailed(receipt.id, attempts, abandon ? now() : null);
      failed += 1;
      log.log(abandon ? 'error' : 'warn', abandon ? 'reply.abandoned' : 'reply.failed', {
        ...fields,
        attempts,
        error: code,
      });
      // The Git host asks us to wait: the other replies would fail the same way.
      if (code === 'rate_limited') break;
    }
  }
  return { posted, failed };
}
