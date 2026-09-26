// Cost Controller, part 1 (design/D-03 section 5.2, D-07 sections 3, 5 and 6, D-02 FR-50,
// FR-51, D-08 C03, design/ADR-M24).
//
// - `issueRunKey`: one virtual key per run, with the seven labels, the models of the Run Contract,
//   and a budget cap = the smallest of the run budget (contract), what is left of the intent
//   budget and what is left of the tenant's budget for this UTC month (both from `cost_records`).
//   A zero or negative remainder is refused, never turned into a zero-budget key.
// - `endRun`: revokes the key first, then syncs spend once.
// - `syncSpend`: gateway spend rows → `cost_records` (never twice: unique source_ref). The worker
//   schedules it (B07 / C07, ADR-M24 §2.5).
//
// The gateway's own budgets (key, tenant team) are a backstop only: spend is updated
// asynchronously and can overshoot by about one call (QUESTIONS #14). G5 (C07) reads
// `cost_records` itself.
import {
  COST_LABEL_NAMES,
  COST_LABEL_VALUE,
  GATE_CODES,
  validateRunContract,
  type CostLabels,
  type GateCode,
  type ModelGateway,
  type RunContract,
  type RunStatus,
  type VirtualKey,
} from '@sdlc/contracts';

import type { PlatformDatabase } from '../db/platform-database.js';
import type { TenantId } from '../db/tenant-id.js';
import { CostError } from './errors.js';
import { silentCostLogger, type CostLogger } from './logger.js';
import { fromMicros, startOfUtcMonth, toMicros } from './money.js';
import { syncSpend, type SyncRange, type SyncResult } from './sync.js';

/** Keys are issued only before the run starts working (C04 moves it past `provisioning`). */
const STARTABLE: readonly RunStatus[] = ['queued', 'provisioning'];

export interface CostControllerOptions {
  readonly gateway: ModelGateway;
  readonly db: PlatformDatabase;
  readonly now?: () => Date;
  readonly logger?: CostLogger;
}

export interface IssueRunKey {
  readonly tenantId: TenantId;
  readonly runId: string;
  /** The gate the run executes under (label `gate`). */
  readonly gate: GateCode;
  /** Agent key from the agent register (label `agent`), for example `coder-openhands`. */
  readonly agent: string;
}

export interface IssuedRunKey {
  readonly key: VirtualKey;
  readonly labels: CostLabels;
  readonly maxBudgetUsd: string;
  /** Which budget set the cap. */
  readonly limitedBy: 'run' | 'intent' | 'tenant';
}

export interface EndRun {
  readonly keyId: string;
  /** Spend of calls that started at or after this time is synced. */
  readonly syncFrom: Date;
}

function checkLabels(labels: CostLabels): CostLabels {
  for (const name of COST_LABEL_NAMES) {
    if (!COST_LABEL_VALUE.test(labels[name])) {
      throw new CostError('invalid_label', `cost label ${name} is not a code`, name);
    }
  }
  if (!(GATE_CODES as readonly string[]).includes(labels.gate)) {
    throw new CostError('invalid_label', 'cost label gate is not a gate code', 'gate');
  }
  return labels;
}

export class CostController {
  private readonly gateway: ModelGateway;
  private readonly db: PlatformDatabase;
  private readonly now: () => Date;
  private readonly logger: CostLogger;

  constructor(options: CostControllerOptions) {
    this.gateway = options.gateway;
    this.db = options.db;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? silentCostLogger;
  }

  /** Creates the run's virtual key (D-08 C03 AC2, AC5). */
  async issueRunKey(input: IssueRunKey): Promise<IssuedRunKey> {
    const scope = this.db.forTenant(input.tenantId);
    const run = await scope.runs.getById(input.runId);
    const stored = run ? await scope.runContracts.getByRunId(run.id) : undefined;
    const intent = run ? await scope.intents.getById(run.intent_id) : undefined;
    const project = intent ? await scope.projects.getById(intent.project_id) : undefined;
    const tenant = await this.db.system.getTenant(input.tenantId);
    if (!run || !stored || !intent || !project || !tenant) {
      throw new CostError('run_not_found', 'run, contract, intent, project or tenant not found');
    }
    if (!STARTABLE.includes(run.status)) {
      throw new CostError('run_not_startable', `run status ${run.status} does not take a new key`);
    }
    const checked = validateRunContract(stored.contract_json);
    if (!checked.ok) throw new CostError('run_not_found', 'the stored Run Contract is not valid');
    const contract: RunContract = checked.contract;
    if (contract.allowed_models.length === 0) {
      throw new CostError('no_models', 'the Run Contract allows no model');
    }

    const labels = checkLabels({
      tenant: tenant.slug,
      project: project.slug,
      intent_id: intent.code,
      run_id: run.id,
      gate: input.gate,
      agent: input.agent,
      data_class: intent.data_class,
    });

    const runCap = toMicros(contract.max_budget_usd);
    const intentLeft =
      toMicros(intent.budget_usd) - toMicros(await scope.costRecords.totalForIntent(intent.id));
    if (intentLeft <= 0n) {
      throw new CostError('intent_budget_exhausted', 'the intent budget is used up');
    }
    let tenantLeft: bigint | undefined;
    const monthly = tenant.monthly_budget_usd;
    if (monthly === null) {
      this.logger.log('warn', 'cost.tenant_budget_unset', { tenant_id: input.tenantId });
    } else {
      const spent = await scope.costRecords.totalSince(startOfUtcMonth(this.now()));
      tenantLeft = toMicros(monthly) - toMicros(spent);
      if (tenantLeft <= 0n) {
        throw new CostError(
          'tenant_budget_exhausted',
          'the tenant budget of this month is used up',
        );
      }
    }

    let cap = runCap;
    let limitedBy: IssuedRunKey['limitedBy'] = 'run';
    if (intentLeft < cap) [cap, limitedBy] = [intentLeft, 'intent'];
    if (tenantLeft !== undefined && tenantLeft < cap) [cap, limitedBy] = [tenantLeft, 'tenant'];
    const maxBudgetUsd = fromMicros(cap);

    const { tenantGroupId } = await this.gateway.ensureTenantBudget({
      tenantSlug: tenant.slug,
      monthlyBudgetUsd: monthly === null ? null : fromMicros(toMicros(monthly)),
    });
    // The key lives for the contract's start window plus the run's time cap.
    const startWindowMin = Math.ceil(
      (Date.parse(contract.expires_at) - Date.parse(contract.issued_at)) / 60_000,
    );
    const key = await this.gateway.createRunKey({
      runId: run.id,
      labels,
      maxBudgetUsd,
      models: contract.allowed_models,
      durationMinutes: contract.max_duration_min + startWindowMin,
      tenantGroupId,
    });
    this.logger.log('info', 'cost.run_key_issued', {
      tenant_id: input.tenantId,
      run_id: run.id,
      max_budget_usd: maxBudgetUsd,
      limited_by: limitedBy,
    });
    return { key, labels, maxBudgetUsd, limitedBy };
  }

  /** Revokes the run's key (D-08 C03 AC3), then syncs its spend once. */
  async endRun(input: EndRun): Promise<SyncResult> {
    await this.gateway.revokeKey(input.keyId);
    this.logger.log('info', 'cost.run_key_revoked', {});
    return this.syncSpend({ from: input.syncFrom, to: this.now() });
  }

  /** Gateway spend → `cost_records` (D-08 C03 AC4). Safe to run again on the same range. */
  syncSpend(range: SyncRange): Promise<SyncResult> {
    return syncSpend({ gateway: this.gateway, db: this.db, logger: this.logger }, range);
  }
}
