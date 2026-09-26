// Spend sync: gateway call records → `cost_records` (design/D-05 section 6.5, D-08 C03 AC4,
// design/ADR-M24 §2.5). Each call is found by its labels (tenant slug, run ID), checked against
// the database (intent code and project slug must match the run), and inserted once: the unique
// (tenant_id, source_ref) makes a second sync of the same range insert nothing.
//
// A call that cannot be recorded is never dropped silently: it is counted by reason in the result
// and logged as `cost.sync_skipped`.
import {
  GATE_CODES,
  type GateCode,
  type ModelGateway,
  type ProviderType,
  type SpendRecord,
} from '@sdlc/contracts';

import { DbError } from '../db/errors.js';
import type { PlatformDatabase } from '../db/platform-database.js';
import type { Intent, Project, Run } from '../db/schema.js';
import { parseTenantId } from '../db/tenant-id.js';
import type { TenantScope } from '../db/tenant-scope.js';
import type { CostLogger } from './logger.js';
import { isUsd, toMicros } from './money.js';

export interface SyncRange {
  readonly from: Date;
  readonly to: Date;
}

export const SYNC_SKIP_REASONS = [
  /** A failed call with no cost and no tokens: nothing to record. */
  'no_usage',
  /** No tenant or run label: the call did not use a platform run key. */
  'unlabelled',
  'unknown_tenant',
  'unknown_run',
  /** The labels do not match the run in the database (intent, project, gate or agent). */
  'label_mismatch',
  /** The gateway does not list the model, so its provider type is unknown. */
  'unknown_model',
  /** Amount or token counts the database would refuse. */
  'invalid_record',
  /** A gateway row the adapter could not read (for example a negative cost or a missing ID). */
  'unreadable',
] as const;
export type SyncSkipReason = (typeof SYNC_SKIP_REASONS)[number];

export interface SyncResult {
  readonly seen: number;
  readonly inserted: number;
  readonly duplicates: number;
  readonly skipped: Readonly<Partial<Record<SyncSkipReason, number>>>;
}

interface SyncDeps {
  readonly gateway: ModelGateway;
  readonly db: PlatformDatabase;
  readonly logger: CostLogger;
}

interface RunContext {
  readonly scope: TenantScope;
  readonly run: Run;
  readonly intent: Intent;
  readonly project: Project;
}

const AGENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Looks up tenants and runs once per sync. */
class Resolver {
  private readonly scopes = new Map<string, TenantScope | null>();
  private readonly runs = new Map<string, RunContext | null>();

  constructor(private readonly db: PlatformDatabase) {}

  async scope(slug: string): Promise<TenantScope | null> {
    if (!this.scopes.has(slug)) {
      const tenant = await this.db.system.getTenantBySlug(slug);
      this.scopes.set(slug, tenant ? this.db.forTenant(parseTenantId(tenant.id)) : null);
    }
    return this.scopes.get(slug) ?? null;
  }

  async run(scope: TenantScope, runId: string): Promise<RunContext | null> {
    const cacheKey = `${scope.tenantId}/${runId}`;
    if (!this.runs.has(cacheKey)) {
      const run = await scope.runs.getById(runId);
      const intent = run ? await scope.intents.getById(run.intent_id) : undefined;
      const project = intent ? await scope.projects.getById(intent.project_id) : undefined;
      this.runs.set(cacheKey, run && intent && project ? { scope, run, intent, project } : null);
    }
    return this.runs.get(cacheKey) ?? null;
  }
}

type Outcome = 'inserted' | 'duplicate' | SyncSkipReason;

async function syncOne(
  record: SpendRecord,
  resolver: Resolver,
  providerTypes: ReadonlyMap<string, ProviderType>,
): Promise<Outcome> {
  const tokens = record.inputTokens + record.outputTokens;
  const free = isUsd(record.costUsd) && toMicros(record.costUsd) === 0n;
  if (record.status === 'failure' && tokens === 0 && free) return 'no_usage';
  const { tenant, run_id: runId } = record.labels;
  if (!tenant || !runId) return 'unlabelled';
  const scope = await resolver.scope(tenant);
  if (!scope) return 'unknown_tenant';
  const context = await resolver.run(scope, runId);
  if (!context) return 'unknown_run';
  const { labels } = record;
  if (labels.intent_id !== context.intent.code || labels.project !== context.project.slug) {
    return 'label_mismatch';
  }
  const gate = labels.gate ?? null;
  if (gate !== null && !(GATE_CODES as readonly string[]).includes(gate)) return 'label_mismatch';
  const agent = labels.agent ?? null;
  if (agent !== null && !AGENT.test(agent)) return 'label_mismatch';
  const providerType = providerTypes.get(record.model);
  if (!providerType) return 'unknown_model';
  if (!isUsd(record.costUsd)) return 'invalid_record';
  try {
    const inserted = await context.scope.costRecords.insertIfNew({
      projectId: context.project.id,
      intentId: context.intent.id,
      runId: context.run.id,
      gate: gate as GateCode | null,
      agent,
      model: record.model,
      providerType,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      cachedInputTokens: record.cachedInputTokens,
      costUsd: record.costUsd,
      sourceRef: record.sourceRef,
      occurredAt: record.occurredAt,
    });
    return inserted ? 'inserted' : 'duplicate';
  } catch (error) {
    if (error instanceof DbError && error.code === 'invalid_value') return 'invalid_record';
    throw error;
  }
}

export async function syncSpend(deps: SyncDeps, range: SyncRange): Promise<SyncResult> {
  const [{ records, unreadable }, models] = await Promise.all([
    deps.gateway.listSpend(range),
    deps.gateway.listModels(),
  ]);
  const providerTypes = new Map(models.map((m) => [m.model, m.providerType] as const));
  const resolver = new Resolver(deps.db);
  let inserted = 0;
  let duplicates = 0;
  const skipped: Partial<Record<SyncSkipReason, number>> = unreadable > 0 ? { unreadable } : {};
  // One at a time: the calls of one run share lookups, and the volume per sync is small.
  for (const record of records) {
    const outcome = await syncOne(record, resolver, providerTypes);
    if (outcome === 'inserted') inserted += 1;
    else if (outcome === 'duplicate') duplicates += 1;
    else skipped[outcome] = (skipped[outcome] ?? 0) + 1;
  }
  const seen = records.length + unreadable;
  const result: SyncResult = { seen, inserted, duplicates, skipped };
  deps.logger.log('info', 'cost.sync_done', { seen, inserted, duplicates });
  // `no_usage` and `unlabelled` are expected (failed calls, admin checks); the others lose cost data.
  const lost = Object.entries(skipped).filter(([r]) => r !== 'no_usage' && r !== 'unlabelled');
  if (lost.length > 0) deps.logger.log('warn', 'cost.sync_skipped', Object.fromEntries(lost));
  return result;
}
