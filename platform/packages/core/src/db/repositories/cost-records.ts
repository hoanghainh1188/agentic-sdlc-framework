// Cost records (design/D-05 section 6.5, D-08 C03 AC4, design/ADR-M24). Append-only: rows are
// only inserted; the database refuses UPDATE, DELETE and TRUNCATE (triggers and grants). Every
// column is a code, an ID or a number (never free text), checked here and again by the database.
import { GATE_CODES, PROVIDER_TYPES, type GateCode, type ProviderType } from '@sdlc/contracts';

import { DbError } from '../errors.js';
import type { CostRecordRow } from '../schema.js';
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
}
