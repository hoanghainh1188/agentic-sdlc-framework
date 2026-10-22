import type { TenantInsert, ToolApproval } from '../schema.js';
import { TenantRepository } from './base.js';

/** Approvals of the tool register (X04, ADR-M69 §2.2). Append-only: insert and read, nothing else. */
export class ToolApprovalRepository extends TenantRepository {
  /** Fails with `conflict` when the person or the capacity already approved this round. */
  record(input: TenantInsert<'tool_approvals'>): Promise<ToolApproval> {
    return this.run(
      this.db
        .insertInto('tool_approvals')
        .values({ ...input, tenant_id: this.tenantId })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }

  /** The approvals of one round: the tool as it is now (`round_at` = its `updated_at`). */
  listForRound(
    toolId: string,
    purpose: ToolApproval['purpose'],
    roundAt: Date,
  ): Promise<ToolApproval[]> {
    return this.run(
      this.db
        .selectFrom('tool_approvals')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('tool_id', '=', toolId)
        .where('purpose', '=', purpose)
        .where('round_at', '=', roundAt)
        .orderBy('created_at')
        .orderBy('id')
        .execute(),
    );
  }
}
