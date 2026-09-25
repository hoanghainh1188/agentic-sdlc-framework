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
}
