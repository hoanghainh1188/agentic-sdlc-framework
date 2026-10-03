// Intents (design/D-05 section 6.2, D-02 FR-01 and FR-03, D-08 B02 AC1 and AC2).
import type { ActorType, DataClass, GateCode, IntentStatus, RiskTier } from '@sdlc/contracts';
import { INTENT_STATUSES, GATE_CODES } from '@sdlc/contracts';
import { sql, type Kysely } from 'kysely';

import { fromMicros, isUsd, toMicros } from '../../cost/money.js';
import { clock, loadEffectiveConfig, type RegistryDeps } from '../../registry/effective-config.js';
import { RegistryError } from '../../registry/errors.js';
import { formatIntentCode, intentCodeYear } from '../../registry/intent-code.js';
import { DbError } from '../errors.js';
import type { Database, Intent } from '../schema.js';
import { isUuid } from '../tenant-id.js';
import { AuditLogRepository } from './audit-log.js';
import { TenantRepository } from './base.js';
import { lockIntent, lockIntentCodes } from './locks.js';
import { ProjectConfigRepository } from './project-configs.js';

export interface NewIntent {
  readonly projectId: string;
  readonly title: string;
  readonly description?: string;
  /** The intent owner (Person A), who approves G1 (design/QUESTIONS.md #16). */
  readonly createdBy: string;
  readonly riskTier: RiskTier;
  readonly dataClass: DataClass;
  /** USD, as a decimal string (D-05 D6). Default: `budget.default_intent_usd` from the config. */
  readonly budgetUsd?: string;
  readonly issueNumber?: number | null;
}

export interface IntentStateChange {
  readonly status: IntentStatus;
  readonly currentGate: GateCode | null;
  readonly actorType: Exclude<ActorType, 'agent'>;
  /** Required for `human`; null for `system`. */
  readonly actorId: string | null;
}

/** A move of the intent workflow (B07): applied only when the intent is still in `from`. */
export interface IntentMove {
  readonly from: { readonly status: IntentStatus; readonly currentGate: GateCode | null };
  readonly to: { readonly status: IntentStatus; readonly currentGate: GateCode | null };
  /** When the move enters `to.currentGate` (null when it leaves the gates). */
  readonly at: Date;
}

export interface IntentQuery {
  readonly status?: IntentStatus;
}

/** Keyset position: the last intent of the previous page (task B03). */
export interface IntentPosition {
  readonly createdAt: Date;
  readonly id: string;
}

export interface IntentPageQuery {
  /** Projects to include. An empty list gives an empty page. */
  readonly projectIds: readonly string[];
  readonly status?: IntentStatus;
  /** 1 to `MAX_INTENT_PAGE`. */
  readonly limit: number;
  readonly after?: IntentPosition;
}

export const MAX_INTENT_PAGE = 100;

const MONEY = /^\d{1,12}(\.\d{1,6})?$/;

export class IntentRepository extends TenantRepository {
  /**
   * Creates an intent in status `draft` with the next code of the tenant for the current UTC year.
   * `max_autonomy` comes from the policy engine of the project configuration (FR-03). In the same
   * transaction, appends `intent.created` (never the title or description).
   */
  async create(input: NewIntent, deps: RegistryDeps): Promise<Intent> {
    const budget = input.budgetUsd;
    if (budget !== undefined && !MONEY.test(budget)) {
      throw new DbError('invalid_value', 'budgetUsd must be a non-negative decimal string');
    }
    const year = intentCodeYear(clock(deps));
    return this.run(
      this.transactional(async (db) => {
        const project = await db
          .selectFrom('projects')
          .select(['id', 'status'])
          .where('tenant_id', '=', this.tenantId)
          .where('id', '=', input.projectId)
          .executeTakeFirst();
        if (project?.status !== 'active') {
          throw new RegistryError('project_not_active', `project ${input.projectId} is not active`);
        }
        const { config } = await loadEffectiveConfig(
          new ProjectConfigRepository(db, this.tenantId),
          input.projectId,
        );
        const policy = deps.policyFactory(config);
        const maxAutonomy = policy.maxAutonomy({
          riskTier: input.riskTier,
          dataClass: input.dataClass,
        });

        await lockIntentCodes(db, this.tenantId);
        const code = formatIntentCode(year, (await this.lastNumber(db, year)) + 1);
        const intent = await db
          .insertInto('intents')
          .values({
            tenant_id: this.tenantId,
            code,
            project_id: input.projectId,
            title: input.title,
            description: input.description ?? '',
            created_by: input.createdBy,
            risk_tier: input.riskTier,
            data_class: input.dataClass,
            max_autonomy: maxAutonomy,
            budget_usd: budget ?? String(config.budget.default_intent_usd),
            issue_number: input.issueNumber ?? null,
          })
          .returningAll()
          .executeTakeFirstOrThrow()
          .catch((error: unknown) => {
            // One open intent per issue (QUESTIONS #68): a comment always names exactly one.
            if (
              (error as { constraint?: unknown } | null)?.constraint === 'intents_open_issue_key'
            ) {
              throw new RegistryError(
                'issue_already_linked',
                `another open intent is linked to issue ${String(input.issueNumber)}`,
              );
            }
            throw error;
          });
        await new AuditLogRepository(db, this.tenantId).append({
          action: 'intent.created',
          actorType: 'human',
          actorId: intent.created_by,
          entityId: intent.id,
          payload: {
            code: intent.code,
            project_id: intent.project_id,
            risk_tier: intent.risk_tier,
            data_class: intent.data_class,
            max_autonomy: intent.max_autonomy,
          },
        });
        return intent;
      }),
    );
  }

  getById(id: string): Promise<Intent | undefined> {
    if (!isUuid(id)) return Promise.resolve(undefined);
    return this.run(
      this.db
        .selectFrom('intents')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .executeTakeFirst(),
    );
  }

  getByCode(code: string): Promise<Intent | undefined> {
    return this.run(
      this.db
        .selectFrom('intents')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('code', '=', code)
        .executeTakeFirst(),
    );
  }

  /**
   * Open intents of a project linked to an issue or a pull request (task B06: a comment command
   * on GitHub → its intent). An open intent is one not `done`, `rejected`, `cancelled` or
   * `blocked` (C06: a blocked intent is finished, migration 0011). Returns
   * at most two rows: two mean the link is ambiguous (design/QUESTIONS.md #68).
   */
  findOpenByGitNumber(
    projectId: string,
    link: { readonly kind: 'issue' | 'pull_request'; readonly number: number },
  ): Promise<Intent[]> {
    const column = link.kind === 'issue' ? 'issue_number' : 'pr_number';
    return this.run(
      this.db
        .selectFrom('intents')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('project_id', '=', projectId)
        .where(column, '=', link.number)
        .where('status', 'not in', ['done', 'rejected', 'cancelled', 'blocked'])
        .orderBy('created_at')
        .limit(2)
        .execute(),
    );
  }

  listForProject(projectId: string, query: IntentQuery = {}): Promise<Intent[]> {
    return this.run(
      this.db
        .selectFrom('intents')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('project_id', '=', projectId)
        .$if(query.status !== undefined, (qb) => qb.where('status', '=', query.status!))
        .orderBy('code')
        .execute(),
    );
  }

  /**
   * One page of intents of the given projects, newest first, by (`created_at`, `id`). Returns at
   * most `limit` rows; callers ask for one more to know whether a next page exists.
   */
  page(query: IntentPageQuery): Promise<Intent[]> {
    if (
      !Number.isSafeInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > MAX_INTENT_PAGE + 1
    ) {
      throw new DbError('invalid_value', `limit must be 1 to ${String(MAX_INTENT_PAGE)}`);
    }
    if (query.projectIds.length === 0) return Promise.resolve([]);
    const after = query.after;
    return this.run(
      this.db
        .selectFrom('intents')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('project_id', 'in', [...query.projectIds])
        .$if(query.status !== undefined, (qb) => qb.where('status', '=', query.status!))
        .$if(after !== undefined, (qb) =>
          qb.where((eb) =>
            eb.or([
              eb('created_at', '<', after!.createdAt),
              eb.and([eb('created_at', '=', after!.createdAt), eb('id', '<', after!.id)]),
            ]),
          ),
        )
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(query.limit)
        .execute(),
    );
  }

  /**
   * Moves the intent to a status and gate. Which moves are allowed belongs to the workflow (B07).
   * In the same transaction, appends `intent.state_changed`.
   */
  async updateState(id: string, change: IntentStateChange): Promise<Intent> {
    // Checked at runtime too: the type can be bypassed with a cast (D-02 FR-11).
    if ((change.actorType as string) === 'agent') {
      throw new DbError('invalid_value', 'agents never change the state of an intent');
    }
    if (!INTENT_STATUSES.includes(change.status)) {
      throw new DbError('invalid_value', 'unknown status');
    }
    if (change.currentGate !== null && !GATE_CODES.includes(change.currentGate)) {
      throw new DbError('invalid_value', 'unknown gate');
    }
    return this.run(
      this.transactional(async (db) => {
        const intent = await db
          .updateTable('intents')
          .set({
            status: change.status,
            current_gate: change.currentGate,
            updated_at: sql<Date>`now()`,
          })
          .where('tenant_id', '=', this.tenantId)
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirst();
        if (!intent) throw new RegistryError('intent_not_found', `intent ${id} not found`);
        await new AuditLogRepository(db, this.tenantId).append({
          action: 'intent.state_changed',
          actorType: change.actorType,
          actorId: change.actorId,
          entityId: intent.id,
          payload: {
            status: intent.status,
            ...(intent.current_gate === null ? {} : { current_gate: intent.current_gate }),
          },
        });
        return intent;
      }),
    );
  }

  /** Holds the intent lock until the transaction ends, then reads the intent (B07 workflow step). */
  async lockAndGet(id: string): Promise<Intent | undefined> {
    if (!isUuid(id)) return undefined;
    if (!this.db.isTransaction) {
      throw new DbError('invalid_value', 'lockAndGet must run inside a transaction');
    }
    await lockIntent(this.db, id);
    return this.getById(id);
  }

  /**
   * Moves the intent with compare-and-set (task B07, ADR-M30): only when its status and gate still
   * equal `move.from`. Returns the moved intent, or undefined when it is no longer in `from` (for
   * example an activity retried after the move was committed). A move to another gate sets
   * `gate_entered_at`; staying at the same gate keeps it. The workflow is the only caller; it
   * checks which moves are allowed. Appends `intent.state_changed` (system actor) in the same
   * transaction.
   */
  async moveState(id: string, move: IntentMove): Promise<Intent | undefined> {
    for (const state of [move.from, move.to]) {
      if (!INTENT_STATUSES.includes(state.status)) throw new DbError('invalid_value', 'status');
      if (state.currentGate !== null && !GATE_CODES.includes(state.currentGate)) {
        throw new DbError('invalid_value', 'unknown gate');
      }
    }
    const entersGate = move.to.currentGate !== move.from.currentGate;
    return this.run(
      this.transactional(async (db) => {
        const intent = await db
          .updateTable('intents')
          .set({
            status: move.to.status,
            current_gate: move.to.currentGate,
            ...(entersGate
              ? { gate_entered_at: move.to.currentGate === null ? null : move.at }
              : {}),
            updated_at: sql<Date>`now()`,
          })
          .where('tenant_id', '=', this.tenantId)
          .where('id', '=', id)
          .where('status', '=', move.from.status)
          .$if(move.from.currentGate === null, (qb) => qb.where('current_gate', 'is', null))
          .$if(move.from.currentGate !== null, (qb) =>
            qb.where('current_gate', '=', move.from.currentGate!),
          )
          .returningAll()
          .executeTakeFirst();
        if (!intent) return undefined;
        await new AuditLogRepository(db, this.tenantId).append({
          action: 'intent.state_changed',
          actorType: 'system',
          actorId: null,
          entityId: intent.id,
          payload: {
            status: intent.status,
            ...(intent.current_gate === null ? {} : { current_gate: intent.current_gate }),
          },
        });
        return intent;
      }),
    );
  }

  /**
   * Raises the intent budget by `addUsd` and sets the run budget of its next runs (task C07, G5
   * `resume` with `budget_increase_usd`, QUESTIONS #133). Both only go up (trigger SDA11). Appends
   * `intent.budget_increased` with the amounts and the escalation that allowed it. Call under the
   * intent lock.
   */
  async raiseBudget(
    id: string,
    raise: {
      readonly addUsd: string;
      readonly runBudgetUsd: string;
      readonly escalationId: string;
    },
  ): Promise<Intent> {
    for (const amount of [raise.addUsd, raise.runBudgetUsd]) {
      if (!isUsd(amount) || toMicros(amount) <= 0n) {
        throw new DbError('invalid_value', 'a budget amount must be a decimal above 0');
      }
    }
    if (!isUuid(raise.escalationId)) throw new DbError('invalid_value', 'escalationId');
    return this.run(
      this.transactional(async (db) => {
        const current = await new IntentRepository(db, this.tenantId).getById(id);
        if (!current) throw new DbError('reference_not_found', `intent ${id} not found`);
        const budgetUsd = fromMicros(toMicros(current.budget_usd) + toMicros(raise.addUsd));
        const intent = await db
          .updateTable('intents')
          .set({
            budget_usd: budgetUsd,
            run_budget_usd: raise.runBudgetUsd,
            updated_at: sql<Date>`now()`,
          })
          .where('tenant_id', '=', this.tenantId)
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await new AuditLogRepository(db, this.tenantId).append({
          action: 'intent.budget_increased',
          actorType: 'system',
          actorId: null,
          entityId: intent.id,
          payload: {
            escalation_id: raise.escalationId,
            added_usd: fromMicros(toMicros(raise.addUsd)),
            budget_usd: budgetUsd,
            run_budget_usd: fromMicros(toMicros(raise.runBudgetUsd)),
          },
        });
        return intent;
      }),
    );
  }

  /** Highest number used this year by the tenant, 0 when none. Call with the code lock held. */
  private async lastNumber(db: Kysely<Database>, year: number): Promise<number> {
    const row = await db
      .selectFrom('intents')
      .select(sql<number | null>`max(substring(code from 10)::int)`.as('last'))
      .where('tenant_id', '=', this.tenantId)
      .where('code', 'like', `INT-${String(year)}-%`)
      .executeTakeFirst();
    return row?.last ?? 0;
  }
}
