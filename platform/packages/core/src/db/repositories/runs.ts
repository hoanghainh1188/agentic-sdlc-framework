// Agent runs (design/D-05 section 6.4). Runs are created with their Run Contract
// (`RunContractRepository.store`); state changes belong to the runner and the worker (C04, C07,
// C11). The database refuses any change once the status is final (ADR-M22).
import type { RunStatus } from '@sdlc/contracts';
import { sql } from 'kysely';

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
      /** Agent steps completed (C05). */
      readonly iterations?: number;
      /** The person who used the kill switch (C11); only with `stopping` or `stopped_killed`. */
      readonly killedBy?: string;
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
          ...(change.iterations === undefined ? {} : { iterations: change.iterations }),
          ...(change.killedBy === undefined ? {} : { killed_by: change.killedBy }),
        })
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .where('status', 'in', change.from)
        .executeTakeFirst(),
    );
    return result.numUpdatedRows === 1n;
  }

  /**
   * Ends a run (C11, ADR-M42 §2.2): from one of `from` to `to`, **or**, when the kill switch moved
   * it to `stopping` meanwhile, to `stopped_killed` / `killed`, in **one** conditional update, so a
   * kill that lands between a writer's read and its update never leaves the run in `stopping`.
   * Returns the status the run now has, or undefined when it was in neither (another writer ended
   * it first). `stopReason`, `startedAt` and `iterations` apply to the `to` case only.
   */
  async end(
    id: string,
    change: {
      readonly from: readonly RunStatus[];
      readonly to: RunStatus;
      readonly now: Date;
      readonly stopReason?: string;
      readonly finishedAt?: Date;
      readonly iterations?: number;
    },
  ): Promise<RunStatus | undefined> {
    if (!isUuid(id) || change.from.includes('stopping')) return undefined;
    const killed = sql<boolean>`status = 'stopping'`;
    const row = await this.run(
      this.db
        .updateTable('runs')
        .set({
          status: sql`CASE WHEN ${killed} THEN 'stopped_killed'::run_status ELSE ${change.to}::run_status END`,
          stop_reason: sql`CASE WHEN ${killed} THEN 'killed'
            ELSE COALESCE(${change.stopReason ?? null}::text, stop_reason) END`,
          finished_at: sql`CASE WHEN ${killed} THEN ${change.finishedAt ?? change.now}::timestamptz
            ELSE COALESCE(${change.finishedAt ?? null}::timestamptz, finished_at) END`,
          ...(change.iterations === undefined ? {} : { iterations: change.iterations }),
          updated_at: change.now,
        })
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .where('status', 'in', [...change.from, 'stopping'])
        .returning('status')
        .executeTakeFirst(),
    );
    return row?.status;
  }

  /**
   * Records the commit the runner pushed for a `succeeded` run (C08, ADR-M38 §2.2): `head_sha`
   * goes from null to `headSha` once (migration 0017). Returns false when the run is not
   * `succeeded` or already has another head; true when it holds `headSha` (also a repeat).
   */
  async recordPushedHead(id: string, headSha: string, now: Date): Promise<boolean> {
    if (!isUuid(id) || !/^[0-9a-f]{40}$/.test(headSha)) return false;
    const result = await this.run(
      this.db
        .updateTable('runs')
        .set({ head_sha: headSha, updated_at: now })
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .where('status', '=', 'succeeded')
        .where('head_sha', 'is', null)
        .executeTakeFirst(),
    );
    if (result.numUpdatedRows === 1n) return true;
    return (await this.getById(id))?.head_sha === headSha;
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
