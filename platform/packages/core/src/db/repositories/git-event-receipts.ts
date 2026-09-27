// Receipts of Git host events (D-05 section 6.1b, task B06, design/ADR-M27): idempotency by
// event ID and the outbox of reply comments. Codes and IDs only.
import type { GitEventReceipt } from '../schema.js';
import { TenantRepository } from './base.js';

export interface NewGitEventReceipt {
  readonly projectId: string;
  readonly eventId: string;
  readonly outcome: string;
  readonly gateDecisionId?: string | null;
  readonly issueNumber?: number | null;
  /** A reply to post on the issue or pull request: a code and code parameters, never text. */
  readonly reply?: { readonly code: string; readonly params: Readonly<Record<string, string>> };
}

export class GitEventReceiptRepository extends TenantRepository {
  find(projectId: string, eventId: string): Promise<GitEventReceipt | undefined> {
    return this.run(
      this.db
        .selectFrom('git_event_receipts')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('project_id', '=', projectId)
        .where('event_id', '=', eventId)
        .executeTakeFirst(),
    );
  }

  /** Fails with `DbError('conflict')` when the event already has a receipt. */
  record(input: NewGitEventReceipt): Promise<GitEventReceipt> {
    return this.run(
      this.db
        .insertInto('git_event_receipts')
        .values({
          tenant_id: this.tenantId,
          project_id: input.projectId,
          event_id: input.eventId,
          outcome: input.outcome,
          gate_decision_id: input.gateDecisionId ?? null,
          issue_number: input.issueNumber ?? null,
          reply_code: input.reply?.code ?? null,
          reply_params: input.reply ? JSON.stringify(input.reply.params) : null,
        })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }

  /** Replies not yet posted or abandoned, in the order of the events. */
  pendingReplies(projectId: string, limit: number): Promise<GitEventReceipt[]> {
    return this.run(
      this.db
        .selectFrom('git_event_receipts')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('project_id', '=', projectId)
        .where('reply_code', 'is not', null)
        .where('reply_posted_at', 'is', null)
        .where('reply_abandoned_at', 'is', null)
        .orderBy('id')
        .limit(limit)
        .execute(),
    );
  }

  /**
   * Records the delivery. Conditional: a reply another poller already finished stays as it is
   * (returns false) instead of hitting the final-delivery trigger.
   */
  async markReplyPosted(id: string, attempts: number, at: Date): Promise<boolean> {
    const updated = await this.run(
      this.db
        .updateTable('git_event_receipts')
        .set({ reply_attempts: attempts, reply_posted_at: at })
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .where('reply_posted_at', 'is', null)
        .where('reply_abandoned_at', 'is', null)
        .where('reply_attempts', '<=', attempts)
        .executeTakeFirst(),
    );
    return updated.numUpdatedRows > 0n;
  }

  /** Counts a failed attempt; gives the reply up when `abandonAt` is set. Conditional, like above. */
  async markReplyFailed(id: string, attempts: number, abandonAt: Date | null): Promise<boolean> {
    const updated = await this.run(
      this.db
        .updateTable('git_event_receipts')
        .set(
          abandonAt === null
            ? { reply_attempts: attempts }
            : { reply_attempts: attempts, reply_abandoned_at: abandonAt },
        )
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .where('reply_posted_at', 'is', null)
        .where('reply_abandoned_at', 'is', null)
        .where('reply_attempts', '<=', attempts)
        .executeTakeFirst(),
    );
    return updated.numUpdatedRows > 0n;
  }
}
