// Intents (design/D-05 section 6.2, D-02 FR-01 and FR-03, D-08 B02 AC1 and AC2).
import type { ActorType, DataClass, GateCode, IntentStatus, RiskTier } from '@sdlc/contracts';
import { INTENT_STATUSES, GATE_CODES } from '@sdlc/contracts';
import { sql, type Kysely } from 'kysely';

import { clock, loadEffectiveConfig, type RegistryDeps } from '../../registry/effective-config.js';
import { RegistryError } from '../../registry/errors.js';
import { formatIntentCode, intentCodeYear } from '../../registry/intent-code.js';
import { DbError } from '../errors.js';
import type { Database, Intent } from '../schema.js';
import { isUuid } from '../tenant-id.js';
import { AuditLogRepository } from './audit-log.js';
import { TenantRepository } from './base.js';
import { lockIntentCodes } from './locks.js';
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
          .executeTakeFirstOrThrow();
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
   * on GitHub → its intent). An open intent is one not `done`, `rejected` or `cancelled`. Returns
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
        .where('status', 'not in', ['done', 'rejected', 'cancelled'])
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
