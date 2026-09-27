import { DbError } from '../errors.js';
import type { GitEventCursor } from '../schema.js';
import { TenantRepository } from './base.js';

export class GitEventCursorRepository extends TenantRepository {
  get(projectId: string): Promise<GitEventCursor | undefined> {
    return this.run(
      this.db
        .selectFrom('git_event_cursors')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('project_id', '=', projectId)
        .executeTakeFirst(),
    );
  }

  /**
   * Stores the cursor of the last processed event. Not an `ON CONFLICT DO UPDATE` upsert: its
   * target row could belong to another tenant, so the tenant guard forbids it.
   */
  save(projectId: string, cursor: string, polledAt: Date = new Date()): Promise<GitEventCursor> {
    return this.run(
      this.db.transaction().execute(async (trx) => {
        const updated = await trx
          .updateTable('git_event_cursors')
          .set({ cursor, last_polled_at: polledAt })
          .where('tenant_id', '=', this.tenantId)
          .where('project_id', '=', projectId)
          .returningAll()
          .executeTakeFirst();
        return (
          updated ??
          trx
            .insertInto('git_event_cursors')
            .values({
              tenant_id: this.tenantId,
              project_id: projectId,
              cursor,
              last_polled_at: polledAt,
            })
            .returningAll()
            .executeTakeFirstOrThrow()
        );
      }),
    );
  }

  /**
   * Compare-and-set (task B06, ADR-M27): stores `next` only when the stored cursor is still
   * `expected` (null: the project has no cursor yet). Returns false when another poller moved it
   * first. Call it inside the transaction that applies the events: the updated row stays locked
   * until that transaction ends, so a second poller waits here and then gets false.
   * A false result after a failed insert leaves the transaction aborted; roll it back.
   */
  async saveIfUnchanged(
    projectId: string,
    expected: string | null,
    next: string,
    polledAt: Date = new Date(),
  ): Promise<boolean> {
    if (expected === null) {
      try {
        await this.run(
          this.db
            .insertInto('git_event_cursors')
            .values({
              tenant_id: this.tenantId,
              project_id: projectId,
              cursor: next,
              last_polled_at: polledAt,
            })
            .execute(),
        );
        return true;
      } catch (error) {
        if (error instanceof DbError && error.code === 'conflict') return false;
        throw error;
      }
    }
    const updated = await this.run(
      this.db
        .updateTable('git_event_cursors')
        .set({ cursor: next, last_polled_at: polledAt })
        .where('tenant_id', '=', this.tenantId)
        .where('project_id', '=', projectId)
        .where('cursor', '=', expected)
        .returning('project_id')
        .executeTakeFirst(),
    );
    return updated !== undefined;
  }
}
