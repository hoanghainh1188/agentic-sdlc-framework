// Cost records (design/D-05 section 6.5, D-08 C03 AC4, design/ADR-M24). Append-only: rows are
// only inserted; the database refuses UPDATE, DELETE and TRUNCATE (triggers and grants). Every
// column is a code, an ID or a number (never free text), checked here and again by the database.
import {
  GATE_CODES,
  PROVIDER_TYPES,
  type GateCode,
  type ProviderType,
  type RunStatus,
} from '@sdlc/contracts';
import type { ExpressionBuilder } from 'kysely';

import { DbError } from '../errors.js';
import type { CostRecordRow, Database } from '../schema.js';
import { isUuid } from '../tenant-id.js';
import { TenantRepository } from './base.js';

export interface NewCostRecord {
  readonly projectId: string;
  readonly intentId: string | null;
  readonly runId: string | null;
  readonly gate: GateCode | null;
  readonly agent: string | null;
  readonly model: string;
  readonly providerType: ProviderType;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  /** Decimal string, at most 6 decimals (D-05 D6). */
  readonly costUsd: string;
  readonly sourceRef: string;
  readonly occurredAt: Date;
}

// Same formats as the CHECKs of migration 0005.
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;
const AGENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SOURCE_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const USD = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/;

/** What a cost report groups by (task E04, ADR-M45 §2.4). */
export const COST_REPORT_GROUPS = ['project', 'intent', 'model', 'status'] as const;
export type CostReportGroup = (typeof COST_REPORT_GROUPS)[number];

/** Which records a cost report reads: always one tenant, a half-open range on `occurred_at`. */
export interface CostReportQuery {
  readonly from: Date;
  readonly to: Date;
  readonly projectId?: string;
  readonly intentId?: string;
  readonly groupBy: CostReportGroup;
  /** Rows to read; the caller asks one more than it shows to know the list is cut. */
  readonly limit: number;
  /** Final run statuses whose tokens are wasted (D-07 §5, QUESTIONS #195). */
  readonly wastedStatuses: readonly RunStatus[];
}

/**
 * Sums of a set of records, as PostgreSQL returns them: bigint and numeric sums are strings, and
 * money keeps its decimal scale (never a float, D-05 D6). Null sums are already 0.
 */
export interface CostSums {
  readonly calls: string;
  readonly input_tokens: string;
  readonly output_tokens: string;
  readonly cached_input_tokens: string;
  readonly cost_usd: string;
  readonly wasted_tokens: string;
  readonly wasted_cost_usd: string;
}

/** One row of a grouped report. `key` is null for records without an intent or a run. */
export interface CostReportRow extends CostSums {
  readonly key: string | null;
}

/** How fresh the synced records of a scope are (QUESTIONS #197, ADR-M45 §2.5). */
export interface CostFreshness {
  /** The latest model call recorded in the scope, any time. */
  readonly latestCallAt: Date | null;
  /** When the latest record of the scope was written by a sync. */
  readonly lastRecordedAt: Date | null;
}

type ReportDb = Database & {
  cr: Database['cost_records'];
  p: Database['projects'];
  i: Database['intents'];
  r: Database['runs'];
};
type ReportEb = ExpressionBuilder<ReportDb, 'cr' | 'p' | 'i' | 'r'>;

const GROUP_COLUMN = {
  project: 'p.slug',
  intent: 'i.code',
  model: 'cr.model',
  status: 'r.status',
} as const satisfies Record<CostReportGroup, string>;

function invalid(field: string): never {
  throw new DbError('invalid_value', `cost record: ${field} is not valid`);
}

function isTokenCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function checkRecord(r: NewCostRecord): void {
  if (!isUuid(r.projectId)) invalid('projectId');
  if (r.intentId !== null && !isUuid(r.intentId)) invalid('intentId');
  if (r.runId !== null && !isUuid(r.runId)) invalid('runId');
  if (r.runId !== null && r.intentId === null) invalid('intentId');
  if (r.gate !== null && !(GATE_CODES as readonly string[]).includes(r.gate)) invalid('gate');
  if (r.agent !== null && !AGENT.test(r.agent)) invalid('agent');
  if (!MODEL.test(r.model)) invalid('model');
  if (!(PROVIDER_TYPES as readonly string[]).includes(r.providerType)) invalid('providerType');
  if (!isTokenCount(r.inputTokens)) invalid('inputTokens');
  if (!isTokenCount(r.outputTokens)) invalid('outputTokens');
  if (!isTokenCount(r.cachedInputTokens) || r.cachedInputTokens > r.inputTokens)
    invalid('cachedInputTokens');
  if (!USD.test(r.costUsd)) invalid('costUsd');
  if (!SOURCE_REF.test(r.sourceRef)) invalid('sourceRef');
  if (!(r.occurredAt instanceof Date) || Number.isNaN(r.occurredAt.getTime()))
    invalid('occurredAt');
}

export class CostRecordRepository extends TenantRepository {
  /**
   * Inserts one record unless the tenant already has one with the same `sourceRef`.
   * Returns true when a row was inserted, false for a duplicate.
   */
  // async: an invalid record rejects the promise instead of throwing synchronously.
  async insertIfNew(record: NewCostRecord): Promise<boolean> {
    checkRecord(record);
    const row = await this.run(
      this.db
        .insertInto('cost_records')
        .values({
          tenant_id: this.tenantId,
          project_id: record.projectId,
          intent_id: record.intentId,
          run_id: record.runId,
          gate: record.gate,
          agent: record.agent,
          model: record.model,
          provider_type: record.providerType,
          input_tokens: record.inputTokens,
          output_tokens: record.outputTokens,
          cached_input_tokens: record.cachedInputTokens,
          cost_usd: record.costUsd,
          source_ref: record.sourceRef,
          occurred_at: record.occurredAt,
        })
        .onConflict((oc) => oc.columns(['tenant_id', 'source_ref']).doNothing())
        .returning('id')
        .executeTakeFirst(),
    );
    return row !== undefined;
  }

  /** Total cost of one intent, as a decimal string. */
  async totalForIntent(intentId: string): Promise<string> {
    if (!isUuid(intentId)) return '0';
    const row = await this.run(
      this.db
        .selectFrom('cost_records')
        .select((eb) => eb.fn.coalesce(eb.fn.sum<string>('cost_usd'), eb.val('0')).as('total'))
        .where('tenant_id', '=', this.tenantId)
        .where('intent_id', '=', intentId)
        .executeTakeFirstOrThrow(),
    );
    return String(row.total);
  }

  /** Total cost of the tenant for calls at or after `since`, as a decimal string. */
  async totalSince(since: Date): Promise<string> {
    const row = await this.run(
      this.db
        .selectFrom('cost_records')
        .select((eb) => eb.fn.coalesce(eb.fn.sum<string>('cost_usd'), eb.val('0')).as('total'))
        .where('tenant_id', '=', this.tenantId)
        .where('occurred_at', '>=', since)
        .executeTakeFirstOrThrow(),
    );
    return String(row.total);
  }

  /** Records of one run, oldest first. */
  listForRun(runId: string): Promise<CostRecordRow[]> {
    if (!isUuid(runId)) return Promise.resolve([]);
    return this.run(
      this.db
        .selectFrom('cost_records')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('run_id', '=', runId)
        .orderBy('occurred_at')
        .orderBy('id')
        .execute(),
    );
  }

  /** Totals of the records a report reads, without grouping. */
  async reportTotals(query: Omit<CostReportQuery, 'groupBy' | 'limit'>): Promise<CostSums> {
    const row = await this.run(
      this.reportBase(query)
        .select((eb) => this.sums(eb as unknown as ReportEb, query.wastedStatuses))
        .executeTakeFirstOrThrow(),
    );
    return normaliseSums(row);
  }

  /** Grouped rows, largest cost first, then by key; at most `limit` rows. */
  async reportRows(query: CostReportQuery): Promise<CostReportRow[]> {
    const column = GROUP_COLUMN[query.groupBy];
    const rows = await this.run(
      this.reportBase(query)
        .select((eb) => [
          eb.ref(column).as('key'),
          ...this.sums(eb as unknown as ReportEb, query.wastedStatuses),
        ])
        .groupBy(column)
        .orderBy('cost_usd', 'desc')
        .orderBy('key', (ob) => ob.asc().nullsLast())
        .limit(query.limit)
        .execute(),
    );
    return rows.map((row) => ({
      ...normaliseSums(row),
      key: row.key === null ? null : String(row.key),
    }));
  }

  /** The latest call and the latest write of the records in the scope, over all time. */
  async freshness(scope: { projectId?: string; intentId?: string }): Promise<CostFreshness> {
    const row = await this.run(
      this.db
        .selectFrom('cost_records')
        .select((eb) => [
          eb.fn.max('occurred_at').as('latest_call_at'),
          eb.fn.max('created_at').as('last_recorded_at'),
        ])
        .where('tenant_id', '=', this.tenantId)
        .$if(scope.projectId !== undefined, (qb) =>
          qb.where('project_id', '=', scope.projectId ?? ''),
        )
        .$if(scope.intentId !== undefined, (qb) => qb.where('intent_id', '=', scope.intentId ?? ''))
        .executeTakeFirstOrThrow(),
    );
    return {
      latestCallAt: toDate(row.latest_call_at),
      lastRecordedAt: toDate(row.last_recorded_at),
    };
  }

  /**
   * Runs of the scope in one of `statuses` (the runs still in progress): their spend is synced when
   * they end (ADR-M24 §2.5, QUESTIONS #197), so a report does not show it yet.
   */
  async countRuns(
    scope: { projectId?: string; intentId?: string },
    statuses: readonly RunStatus[],
  ): Promise<number> {
    if (statuses.length === 0) return 0;
    const tenantId = this.tenantId;
    const row = await this.run(
      this.db
        .selectFrom('runs as r')
        .innerJoin('intents as i', (join) =>
          join
            .onRef('i.tenant_id', '=', 'r.tenant_id')
            .onRef('i.id', '=', 'r.intent_id')
            .on('i.tenant_id', '=', tenantId),
        )
        .select((eb) => eb.fn.countAll<string>().as('runs'))
        .where('r.tenant_id', '=', tenantId)
        .where('r.status', 'in', [...statuses])
        .$if(scope.projectId !== undefined, (qb) =>
          qb.where('i.project_id', '=', scope.projectId ?? ''),
        )
        .$if(scope.intentId !== undefined, (qb) =>
          qb.where('r.intent_id', '=', scope.intentId ?? ''),
        )
        .executeTakeFirstOrThrow(),
    );
    return Number(row.runs);
  }

  /** The records of the report: the tenant, the range, the project or intent; runs and names joined. */
  private reportBase(query: Omit<CostReportQuery, 'groupBy' | 'limit'>) {
    const tenantId = this.tenantId;
    return this.db
      .selectFrom('cost_records as cr')
      .innerJoin('projects as p', (join) =>
        join
          .onRef('p.tenant_id', '=', 'cr.tenant_id')
          .onRef('p.id', '=', 'cr.project_id')
          .on('p.tenant_id', '=', tenantId),
      )
      .leftJoin('intents as i', (join) =>
        join
          .onRef('i.tenant_id', '=', 'cr.tenant_id')
          .onRef('i.id', '=', 'cr.intent_id')
          .on('i.tenant_id', '=', tenantId),
      )
      .leftJoin('runs as r', (join) =>
        join
          .onRef('r.tenant_id', '=', 'cr.tenant_id')
          .onRef('r.id', '=', 'cr.run_id')
          .on('r.tenant_id', '=', tenantId),
      )
      .where('cr.tenant_id', '=', tenantId)
      .where('cr.occurred_at', '>=', query.from)
      .where('cr.occurred_at', '<', query.to)
      .$if(query.projectId !== undefined, (qb) =>
        qb.where('cr.project_id', '=', query.projectId ?? ''),
      )
      .$if(query.intentId !== undefined, (qb) =>
        qb.where('cr.intent_id', '=', query.intentId ?? ''),
      );
  }

  private sums(eb: ReportEb, wasted: readonly RunStatus[]) {
    const zero = eb.val('0');
    const tokens = eb('cr.input_tokens', '+', eb.ref('cr.output_tokens'));
    // `in ()` is invalid SQL: the caller always names at least one status (a constant list).
    if (wasted.length === 0) throw new RangeError('cost report: no wasted run status');
    const statuses = [...wasted];
    const wastedSum = (expr: Parameters<typeof eb.fn.sum>[0]) =>
      eb.fn.sum<string>(expr).filterWhere('r.status', 'in', statuses);
    return [
      eb.fn.countAll<string>().as('calls'),
      eb.fn.coalesce(eb.fn.sum<string>('cr.input_tokens'), zero).as('input_tokens'),
      eb.fn.coalesce(eb.fn.sum<string>('cr.output_tokens'), zero).as('output_tokens'),
      eb.fn.coalesce(eb.fn.sum<string>('cr.cached_input_tokens'), zero).as('cached_input_tokens'),
      eb.fn.coalesce(eb.fn.sum<string>('cr.cost_usd'), zero).as('cost_usd'),
      eb.fn.coalesce(wastedSum(tokens), zero).as('wasted_tokens'),
      eb.fn.coalesce(wastedSum('cr.cost_usd'), zero).as('wasted_cost_usd'),
    ] as const;
  }
}

function normaliseSums(row: Record<string, unknown>): CostSums {
  return {
    calls: String(row['calls']),
    input_tokens: String(row['input_tokens']),
    output_tokens: String(row['output_tokens']),
    cached_input_tokens: String(row['cached_input_tokens']),
    cost_usd: String(row['cost_usd']),
    wasted_tokens: String(row['wasted_tokens']),
    wasted_cost_usd: String(row['wasted_cost_usd']),
  };
}

function toDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') return new Date(value);
  throw new TypeError('cost report: unexpected time value');
}
