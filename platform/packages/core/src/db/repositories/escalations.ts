// Escalations and their notices (design/D-05 section 6.4b, D-08 B11, design/ADR-M28). Codes, IDs,
// hashes and references only: the table is kept at least 2 years (D-05 section 10).
import type {
  EscalationRoute,
  EscalationStatus,
  EscalationStep,
  EscalationTrigger,
  ResponseLevel,
  Severity,
} from '@sdlc/contracts';
import { sql, type Kysely } from 'kysely';

import { escalationCodeYear, formatEscalationCode } from '../../escalation/code.js';
import type { EscalationPacket } from '../../escalation/packet.js';
import type { Database, Escalation, EscalationNotice } from '../schema.js';
import { isUuid } from '../tenant-id.js';
import { TenantRepository } from './base.js';
import { lockEscalationCodes } from './locks.js';

export interface NewEscalation {
  readonly intentId: string;
  readonly runId: string | null;
  readonly trigger: EscalationTrigger;
  readonly route: EscalationRoute;
  readonly severity: Severity;
  readonly responseLevel: ResponseLevel;
  /** Checked by `checkPacket` before it gets here. */
  readonly packet: EscalationPacket;
  readonly producerIds: readonly string[];
  readonly ownerId: string | null;
  readonly backupOwnerId: string | null;
  readonly currentStep: EscalationStep;
  readonly ackDueAt: Date;
  readonly remindAt: Date | null;
  readonly resolveDueAt: Date | null;
  readonly nextCheckAt: Date | null;
  /** The time the clocks start from; also the code's year. */
  readonly createdAt: Date;
}

/** The clock columns the worker loop writes (ADR-M28 §2.2). */
export interface EscalationClockUpdate {
  readonly currentStep: EscalationStep;
  readonly backupOwnerId: string | null;
  readonly stepDueAt: Date;
  readonly remindAt: Date | null;
  readonly remindedStep: EscalationStep | null;
  readonly ackMissedAt: Date | null;
  readonly governanceOverdueAt: Date | null;
  readonly resolveOverdueAt: Date | null;
  readonly nextCheckAt: Date | null;
}

/** Changes of an acknowledgement, a decision, a void or a close (B11 PR 2, ADR-M28 §2.4). */
export interface EscalationStateUpdate {
  readonly status?: EscalationStatus;
  readonly currentStep?: EscalationStep;
  readonly stepDueAt?: Date;
  readonly remindAt?: Date | null;
  readonly resolveDueAt?: Date | null;
  readonly resolveOverdueAt?: Date | null;
  readonly nextCheckAt?: Date | null;
  readonly acknowledgedBy?: string;
  readonly acknowledgedAt?: Date;
  /** Null clears the decision (void). Checked by `checkDecision` before it gets here. */
  readonly decision?: Readonly<Record<string, string | boolean>> | null;
  readonly decidedBy?: string | null;
  readonly decidedAt?: Date | null;
  readonly closedAt?: Date;
}

export interface EscalationQuery {
  readonly statuses?: readonly EscalationStatus[];
}

export class EscalationRepository extends TenantRepository {
  /** Inserts an escalation with the tenant's next `ESC-YYYY-NNNN` code for the UTC year. */
  create(input: NewEscalation): Promise<Escalation> {
    const year = escalationCodeYear(input.createdAt);
    return this.run(
      this.transactional(async (db) => {
        await lockEscalationCodes(db, this.tenantId);
        const code = formatEscalationCode(year, (await this.lastNumber(db, year)) + 1);
        return db
          .insertInto('escalations')
          .values({
            tenant_id: this.tenantId,
            code,
            intent_id: input.intentId,
            run_id: input.runId,
            trigger: input.trigger,
            route: input.route,
            severity: input.severity,
            response_level: input.responseLevel,
            packet: JSON.stringify(input.packet),
            producer_ids: [...input.producerIds],
            owner_id: input.ownerId,
            backup_owner_id: input.backupOwnerId,
            current_step: input.currentStep,
            ack_due_at: input.ackDueAt,
            step_due_at: input.ackDueAt,
            remind_at: input.remindAt,
            resolve_due_at: input.resolveDueAt,
            next_check_at: input.nextCheckAt,
            // The escalation clock, like the other clock columns (B07 session 2: one clock).
            created_at: input.createdAt,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      }),
    );
  }

  getById(id: string): Promise<Escalation | undefined> {
    if (!isUuid(id)) return Promise.resolve(undefined);
    return this.run(
      this.db
        .selectFrom('escalations')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .executeTakeFirst(),
    );
  }

  getByCode(code: string): Promise<Escalation | undefined> {
    return this.run(
      this.db
        .selectFrom('escalations')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('code', '=', code)
        .executeTakeFirst(),
    );
  }

  /** The intent's escalations, oldest first. */
  listForIntent(intentId: string, query: EscalationQuery = {}): Promise<Escalation[]> {
    if (!isUuid(intentId)) return Promise.resolve([]);
    const statuses = query.statuses;
    return this.run(
      this.db
        .selectFrom('escalations')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('intent_id', '=', intentId)
        .$if(statuses !== undefined, (qb) => qb.where('status', 'in', [...(statuses ?? [])]))
        .orderBy('created_at')
        .orderBy('code')
        .execute(),
    );
  }

  /** Escalations of the intents of these projects, newest first (API list, B11 PR 2). */
  listForProjects(
    projectIds: readonly string[],
    query: EscalationQuery & { readonly limit: number },
  ): Promise<Escalation[]> {
    const ids = projectIds.filter((id) => isUuid(id));
    if (ids.length === 0) return Promise.resolve([]);
    const statuses = query.statuses;
    return this.run(
      this.db
        .selectFrom('escalations as e')
        .innerJoin('intents as i', (join) =>
          join
            .onRef('i.tenant_id', '=', 'e.tenant_id')
            .onRef('i.id', '=', 'e.intent_id')
            .on('i.tenant_id', '=', this.tenantId),
        )
        .selectAll('e')
        .where('e.tenant_id', '=', this.tenantId)
        .where('i.project_id', 'in', ids)
        .$if(statuses !== undefined, (qb) => qb.where('e.status', 'in', [...(statuses ?? [])]))
        .orderBy('e.created_at', 'desc')
        .orderBy('e.code', 'desc')
        .limit(query.limit)
        .execute(),
    );
  }

  /**
   * Locks the escalation for the clock, inside the caller's transaction. Returns undefined when
   * another transaction holds the lock (`SKIP LOCKED`): that worker advances it instead.
   */
  lockForClock(id: string): Promise<Escalation | undefined> {
    return this.run(
      this.db
        .selectFrom('escalations')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst(),
    );
  }

  updateClock(id: string, update: EscalationClockUpdate, at: Date): Promise<Escalation> {
    return this.run(
      this.db
        .updateTable('escalations')
        .set({
          current_step: update.currentStep,
          backup_owner_id: update.backupOwnerId,
          step_due_at: update.stepDueAt,
          remind_at: update.remindAt,
          reminded_step: update.remindedStep,
          ack_missed_at: update.ackMissedAt,
          governance_overdue_at: update.governanceOverdueAt,
          resolve_overdue_at: update.resolveOverdueAt,
          next_check_at: update.nextCheckAt,
          updated_at: at,
        })
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }

  /** Locks the row until the transaction ends (acknowledge, decide, void, close). */
  lockForUpdate(id: string): Promise<Escalation | undefined> {
    if (!isUuid(id)) return Promise.resolve(undefined);
    return this.run(
      this.db
        .selectFrom('escalations')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst(),
    );
  }

  updateState(id: string, update: EscalationStateUpdate, at: Date): Promise<Escalation> {
    const set = {
      ...(update.status === undefined ? {} : { status: update.status }),
      ...(update.currentStep === undefined ? {} : { current_step: update.currentStep }),
      ...(update.stepDueAt === undefined ? {} : { step_due_at: update.stepDueAt }),
      ...(update.remindAt === undefined ? {} : { remind_at: update.remindAt }),
      ...(update.resolveDueAt === undefined ? {} : { resolve_due_at: update.resolveDueAt }),
      ...(update.resolveOverdueAt === undefined
        ? {}
        : { resolve_overdue_at: update.resolveOverdueAt }),
      ...(update.nextCheckAt === undefined ? {} : { next_check_at: update.nextCheckAt }),
      ...(update.acknowledgedBy === undefined ? {} : { acknowledged_by: update.acknowledgedBy }),
      ...(update.acknowledgedAt === undefined ? {} : { acknowledged_at: update.acknowledgedAt }),
      ...(update.decision === undefined
        ? {}
        : { decision: update.decision === null ? null : JSON.stringify(update.decision) }),
      ...(update.decidedBy === undefined ? {} : { decided_by: update.decidedBy }),
      ...(update.decidedAt === undefined ? {} : { decided_at: update.decidedAt }),
      ...(update.closedAt === undefined ? {} : { closed_at: update.closedAt }),
    };
    return this.run(
      this.db
        .updateTable('escalations')
        .set({ ...set, updated_at: at })
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }

  private async lastNumber(db: Kysely<Database>, year: number): Promise<number> {
    const row = await db
      .selectFrom('escalations')
      .select(sql<number | null>`max(split_part(code, '-', 3)::int)`.as('last'))
      .where('tenant_id', '=', this.tenantId)
      .where('code', 'like', `ESC-${String(year)}-%`)
      .executeTakeFirst();
    return row?.last ?? 0;
  }
}

export interface NewEscalationNotice {
  readonly kind: string;
  readonly step: EscalationStep;
  readonly audienceRole: EscalationNotice['audience_role'];
}

export class EscalationNoticeRepository extends TenantRepository {
  /** Records notices to post. A notice already recorded (same kind, step and role) is skipped. */
  async record(
    escalationId: string,
    notices: readonly NewEscalationNotice[],
  ): Promise<EscalationNotice[]> {
    if (notices.length === 0) return [];
    return this.run(
      this.db
        .insertInto('escalation_notices')
        .values(
          notices.map((notice) => ({
            tenant_id: this.tenantId,
            escalation_id: escalationId,
            kind: notice.kind,
            step: notice.step,
            audience_role: notice.audienceRole,
          })),
        )
        .onConflict((oc) =>
          oc.columns(['tenant_id', 'escalation_id', 'kind', 'step', 'audience_role']).doNothing(),
        )
        .returningAll()
        .execute(),
    );
  }

  /** Notices still to post for the escalations of one project's intents, oldest first. */
  pendingForProject(projectId: string, limit: number): Promise<EscalationNotice[]> {
    if (!isUuid(projectId)) return Promise.resolve([]);
    return this.run(
      this.db
        .selectFrom('escalation_notices as n')
        .innerJoin('escalations as e', (join) =>
          join
            .onRef('e.tenant_id', '=', 'n.tenant_id')
            .onRef('e.id', '=', 'n.escalation_id')
            .on('e.tenant_id', '=', this.tenantId),
        )
        .innerJoin('intents as i', (join) =>
          join
            .onRef('i.tenant_id', '=', 'e.tenant_id')
            .onRef('i.id', '=', 'e.intent_id')
            .on('i.tenant_id', '=', this.tenantId),
        )
        .selectAll('n')
        .where('n.tenant_id', '=', this.tenantId)
        .where('i.project_id', '=', projectId)
        .where('n.posted_at', 'is', null)
        .where('n.abandoned_at', 'is', null)
        .orderBy('n.id')
        .limit(limit)
        .execute(),
    );
  }

  /**
   * Records the delivery of notices (one comment may carry several). Conditional: notices another
   * poller already finished stay as they are. `abandonAt` gives them up.
   */
  async markDelivery(
    ids: readonly string[],
    result: { readonly attempts: number; readonly postedAt?: Date; readonly abandonAt?: Date },
  ): Promise<void> {
    if (ids.length === 0) return;
    await this.run(
      this.db
        .updateTable('escalation_notices')
        .set({
          attempts: result.attempts,
          ...(result.postedAt ? { posted_at: result.postedAt } : {}),
          ...(result.abandonAt ? { abandoned_at: result.abandonAt } : {}),
        })
        .where('tenant_id', '=', this.tenantId)
        .where('id', 'in', [...ids])
        .where('posted_at', 'is', null)
        .where('abandoned_at', 'is', null)
        .where('attempts', '<=', result.attempts)
        .execute(),
    );
  }

  listForEscalation(escalationId: string): Promise<EscalationNotice[]> {
    if (!isUuid(escalationId)) return Promise.resolve([]);
    return this.run(
      this.db
        .selectFrom('escalation_notices')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('escalation_id', '=', escalationId)
        .orderBy('id')
        .execute(),
    );
  }
}
