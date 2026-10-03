import type { AgentApproval, TenantInsert } from '../schema.js';
import { TenantRepository } from './base.js';

/** Approvals of the agent register (B13 AC7). Append-only: insert and read, nothing else. */
export class AgentApprovalRepository extends TenantRepository {
  /** Fails with `conflict` when the person or the capacity already approved this round. */
  record(input: TenantInsert<'agent_approvals'>): Promise<AgentApproval> {
    return this.run(
      this.db
        .insertInto('agent_approvals')
        .values({ ...input, tenant_id: this.tenantId })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }

  /** The approvals of one round: the agent as it is now (`round_at` = its `updated_at`). */
  listForRound(
    agentId: string,
    purpose: AgentApproval['purpose'],
    roundAt: Date,
  ): Promise<AgentApproval[]> {
    return this.run(
      this.db
        .selectFrom('agent_approvals')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('agent_id', '=', agentId)
        .where('purpose', '=', purpose)
        .where('round_at', '=', roundAt)
        .orderBy('created_at')
        .orderBy('id')
        .execute(),
    );
  }
}
