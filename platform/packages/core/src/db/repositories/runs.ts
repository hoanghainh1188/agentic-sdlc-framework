// Agent runs (design/D-05 section 6.4). Runs are created with their Run Contract
// (`RunContractRepository.store`); state changes belong to the runner and the worker (C04, C07,
// C11). The database refuses any change once the status is final (ADR-M22).
import type { RunStatus } from '@sdlc/contracts';

import type { Run } from '../schema.js';
import { isUuid } from '../tenant-id.js';
import { TenantRepository } from './base.js';

export class RunRepository extends TenantRepository {
  getById(id: string): Promise<Run | undefined> {
    if (!isUuid(id)) return Promise.resolve(undefined);
    return this.run(
      this.db
        .selectFrom('runs')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .executeTakeFirst(),
    );
  }

  /**
   * Claims a `queued` run for provisioning with **one conditional update** (QUESTIONS #35,
   * ADR-M25): `queued → provisioning` only when the run is still `queued`. Returns false when no
   * row changed (the run is unknown, or another runner already claimed it), so one Run Contract
   * starts at most one sandbox.
   */
  async claimForProvisioning(id: string, now: Date): Promise<boolean> {
    if (!isUuid(id)) return false;
    const result = await this.run(
      this.db
        .updateTable('runs')
        .set({ status: 'provisioning', updated_at: now })
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .where('status', '=', 'queued')
        .executeTakeFirst(),
    );
    return result.numUpdatedRows === 1n;
  }

  /**
   * Moves a run from one of `from` to `to` with one conditional update (C04, ADR-M25 §2.8), and
   * sets the given state columns. Returns false when the run is not in `from` any more (another
   * process moved it first). `stopReason` is a code; the database refuses free text.
   */
  async transition(
    id: string,
    change: {
      readonly from: readonly RunStatus[];
      readonly to: RunStatus;
      readonly now: Date;
      readonly stopReason?: string;
      readonly startedAt?: Date;
      readonly finishedAt?: Date;
      /** Last commit of the run's branch (C05). */
      readonly headSha?: string;
      /** Agent steps completed (C05). */
      readonly iterations?: number;
    },
  ): Promise<boolean> {
    if (!isUuid(id) || change.from.length === 0) return false;
    const result = await this.run(
      this.db
        .updateTable('runs')
        .set({
          status: change.to,
          updated_at: change.now,
          ...(change.stopReason === undefined ? {} : { stop_reason: change.stopReason }),
          ...(change.startedAt === undefined ? {} : { started_at: change.startedAt }),
          ...(change.finishedAt === undefined ? {} : { finished_at: change.finishedAt }),
          ...(change.headSha === undefined ? {} : { head_sha: change.headSha }),
          ...(change.iterations === undefined ? {} : { iterations: change.iterations }),
        })
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .where('status', 'in', change.from)
        .executeTakeFirst(),
    );
    return result.numUpdatedRows === 1n;
  }

  /** Runs of one intent, by attempt. */
  listForIntent(intentId: string): Promise<Run[]> {
    if (!isUuid(intentId)) return Promise.resolve([]);
    return this.run(
      this.db
        .selectFrom('runs')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('intent_id', '=', intentId)
        .orderBy('attempt')
        .execute(),
    );
  }
}
