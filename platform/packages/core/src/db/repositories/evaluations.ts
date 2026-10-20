// Evaluations on the server (task L04, design/ADR-M81 §2.2; D-05 §6.8; migration 0029). Always for
// one tenant, with `tenant_id = <tenant>` on every table occurrence. Codes and numbers only: the
// task and configuration IDs, never a prompt, task text, code or diff.
//
// - `create` writes the evaluation, one run per configuration × task × run number, and the audit
//   event `evaluation.started` in one transaction.
// - The status moves forward only (trigger SDA21). `finish` ends it once, with the counts of its
//   runs and its cost in the audit event `evaluation.finished`.
// - The budget is checked against the cost records of its runs (ADR-M81 §2.4): `spentUsd`.
import { DATA_CLASSES, PROVIDER_TYPES, type DataClass, type ProviderType } from '@sdlc/contracts';
import { sql, type Kysely } from 'kysely';

import { toolsSha256 } from '../../agents/fingerprint.js';
import { fromMicros, isUsd, toMicros } from '../../cost/money.js';
import { DbError } from '../errors.js';
import type {
  Database,
  Evaluation,
  EvaluationConfigurationRow,
  EvaluationConfigurationSource,
} from '../schema.js';
import { isUuid } from '../tenant-id.js';
import {
  EVALUATION_FINAL_STATUSES,
  type EvaluationRunStatus,
  type EvaluationStatus,
  type TaskSetKind,
} from '../vocabulary.js';
import { AuditLogRepository } from './audit-log.js';
import { TenantRepository } from './base.js';
import { lockEvaluationCodes } from './locks.js';

/** Same formats as the CHECKs of migration 0029. */
const CODE = /^[a-z][a-z0-9_.-]{0,63}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const SHA = /^[0-9a-f]{40}$/;

/** The most runs one evaluation may queue: a limit of the platform, not of the database. */
export const MAX_EVALUATION_RUNS = 5000;

export interface EvaluationConfigurationInput {
  readonly id: string;
  readonly model: string;
  readonly providerType: ProviderType;
  readonly agentVersion: string;
  /** The configuration's caps, copied to its runs (migration 0030). */
  readonly maxIterations: number;
  readonly maxDurationMin: number;
  /** L05: the register's agent the configuration came from, if any. */
  readonly agentId?: string | null;
  /**
   * L09 (ADR-M86 §2.1): `agent` when the plan named the agent by its key, `model` when it named a
   * model (with the project's default agent). An evaluation of a plan always has it.
   */
  readonly source?: EvaluationConfigurationSource;
  /** L09 (QUESTIONS #501): the tools the agent gets in the runs, its own `allowed_tools`. */
  readonly allowedTools?: readonly string[];
  /** L05: a prompt variant (path, commit, SHA-256 read at start); null: the repository's own. */
  readonly instructions?: {
    readonly path: string;
    readonly commit: string;
    readonly sha256: string;
  } | null;
}

/** L05: the plan an evaluation is started from, and why (ADR-M82 §2.4). */
export interface EvaluationFromPlan {
  readonly id: string;
  readonly version: number;
  /** `manual`, `schedule` or `on_change`. */
  readonly reason: 'manual' | 'schedule' | 'on_change';
}

export interface NewEvaluation {
  readonly projectId: string;
  readonly dataClass: DataClass;
  /** The number of a `folder` task set; null for a `project` task set. */
  readonly taskSetVersion: number | null;
  /** L07 (ADR-M85 §2.10): default `folder`. */
  readonly taskSetKind?: TaskSetKind;
  /** `project` only: the default branch's commit the task cards were read from. */
  readonly taskSetCommit?: string;
  /** `project` only: the base commit of each task, by task ID (each run starts there). */
  readonly taskBaseShas?: Readonly<Record<string, string>>;
  /** The configuration file the runner reads, as a code; null for an evaluation of a plan. */
  readonly configName: string | null;
  /** L05: the plan; its evaluations store their resolved configurations instead of a file. */
  readonly plan?: EvaluationFromPlan;
  /** The commit a `folder` task set's runs start from (40 hex characters); null for `project`. */
  readonly baseSha: string | null;
  readonly taskIds: readonly string[];
  readonly configurations: readonly EvaluationConfigurationInput[];
  readonly runsPerTask: number;
  /** USD, a decimal string, more than 0. */
  readonly budgetUsd: string;
  /** Null when an operator starts it as the system. */
  readonly startedBy: string | null;
  /** The clock of the code year; default `new Date()`. */
  readonly now?: Date;
}

export interface EvaluationCounts {
  readonly queued: number;
  readonly running: number;
  readonly preempted: number;
  readonly scored: number;
  readonly failed: number;
  readonly cancelled: number;
}

export const formatEvaluationCode = (year: number, number: number): string =>
  `EVAL-${String(year)}-${String(number).padStart(4, '0')}`;

function invalid(field: string): never {
  throw new DbError('invalid_value', `evaluation: ${field} is not valid`);
}

function checkCodes(field: string, codes: readonly string[], max: number): void {
  if (codes.length < 1 || codes.length > max) invalid(field);
  if (new Set(codes).size !== codes.length) invalid(field);
  for (const code of codes) if (!CODE.test(code)) invalid(field);
}

/** Checks a new evaluation; throws `DbError('invalid_value')`. Exported for tests. */
export function checkNewEvaluation(input: NewEvaluation): void {
  if (!isUuid(input.projectId)) invalid('projectId');
  if (!(DATA_CLASSES as readonly string[]).includes(input.dataClass)) invalid('dataClass');
  if (input.dataClass === 'prohibited') invalid('dataClass');
  if ((input.taskSetKind ?? 'folder') === 'folder') {
    if (
      input.taskSetVersion === null ||
      !Number.isSafeInteger(input.taskSetVersion) ||
      input.taskSetVersion < 1
    ) {
      invalid('taskSetVersion');
    }
    if (input.baseSha === null || !SHA.test(input.baseSha)) invalid('baseSha');
    if (input.taskSetCommit !== undefined || input.taskBaseShas !== undefined) invalid('taskSet');
  } else {
    if (input.taskSetKind !== 'project') invalid('taskSetKind');
    if (input.taskSetVersion !== null || input.baseSha !== null) invalid('taskSet');
    if (input.taskSetCommit === undefined || !SHA.test(input.taskSetCommit)) {
      invalid('taskSetCommit');
    }
    const shas = input.taskBaseShas ?? {};
    if (input.taskIds.some((id) => !Object.hasOwn(shas, id) || !SHA.test(shas[id] ?? ''))) {
      invalid('taskBaseShas');
    }
  }
  if (input.plan === undefined) {
    if (input.configName === null || !CODE.test(input.configName)) invalid('configName');
  } else {
    if (input.configName !== null) invalid('configName');
    if (!isUuid(input.plan.id)) invalid('plan');
    if (!Number.isSafeInteger(input.plan.version) || input.plan.version < 1) invalid('plan');
    if (!['manual', 'schedule', 'on_change'].includes(input.plan.reason)) invalid('plan');
  }
  checkCodes('taskIds', input.taskIds, 64);
  checkCodes(
    'configurations',
    input.configurations.map((c) => c.id),
    16,
  );
  for (const c of input.configurations) {
    if (!MODEL.test(c.model)) invalid('model');
    if (!(PROVIDER_TYPES as readonly string[]).includes(c.providerType)) invalid('providerType');
    if (!VERSION.test(c.agentVersion)) invalid('agentVersion');
    if (!Number.isSafeInteger(c.maxIterations) || c.maxIterations < 1 || c.maxIterations > 200) {
      invalid('maxIterations');
    }
    if (!Number.isSafeInteger(c.maxDurationMin) || c.maxDurationMin < 1 || c.maxDurationMin > 120) {
      invalid('maxDurationMin');
    }
    if (c.agentId != null && !isUuid(c.agentId)) invalid('agentId');
    if (c.instructions != null) {
      const { path, commit, sha256 } = c.instructions;
      if (!/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+){0,15}$/.test(path)) invalid('instructions');
      if (path.split('/').some((segment) => /^\.+$/.test(segment))) invalid('instructions');
      if (!/^[0-9a-f]{40}$/.test(commit) || !/^[0-9a-f]{64}$/.test(sha256)) {
        invalid('instructions');
      }
    }
    if (input.plan === undefined && (c.agentId != null || c.instructions != null)) {
      invalid('configurations');
    }
  }
  if (!Number.isSafeInteger(input.runsPerTask) || input.runsPerTask < 1 || input.runsPerTask > 50) {
    invalid('runsPerTask');
  }
  if (!isUsd(input.budgetUsd) || toMicros(input.budgetUsd) <= 0n) invalid('budgetUsd');
  if (input.startedBy !== null && !isUuid(input.startedBy)) invalid('startedBy');
  if (
    input.taskIds.length * input.configurations.length * input.runsPerTask >
    MAX_EVALUATION_RUNS
  ) {
    invalid('runs');
  }
}

/** The fingerprint columns of a configuration (ADR-M86 §2.1); both or none. */
function fingerprintColumns(c: EvaluationConfigurationInput): {
  source: EvaluationConfigurationSource | null;
  allowed_tools: string[] | null;
  tools_sha256: string | null;
} {
  if (c.source === undefined || c.allowedTools === undefined) {
    return { source: null, allowed_tools: null, tools_sha256: null };
  }
  const tools = [...c.allowedTools].sort();
  return { source: c.source, allowed_tools: tools, tools_sha256: toolsSha256(tools) };
}

export class EvaluationRepository extends TenantRepository {
  /**
   * Writes the evaluation and its runs (all `queued`) and the audit event, in one transaction.
   * The project must belong to the tenant (a foreign key); its state and data class are checked
   * by the caller (`startEvaluation`).
   */
  // async: an invalid input rejects the promise instead of throwing synchronously.
  async create(input: NewEvaluation): Promise<Evaluation> {
    checkNewEvaluation(input);
    const year = (input.now ?? new Date()).getUTCFullYear();
    return this.run(
      this.transactional(async (db) => {
        await lockEvaluationCodes(db, this.tenantId);
        // L09 (QUESTIONS #503): how many tasks of the project are approved now, at the start.
        const approved = await db
          .selectFrom('evaluation_tasks')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('tenant_id', '=', this.tenantId)
          .where('project_id', '=', input.projectId)
          .where('status', '=', 'approved')
          .executeTakeFirstOrThrow();
        const code = formatEvaluationCode(year, (await this.lastNumber(db, year)) + 1);
        const evaluation = await db
          .insertInto('evaluations')
          .values({
            tenant_id: this.tenantId,
            project_id: input.projectId,
            code,
            data_class: input.dataClass,
            task_set_version: input.taskSetVersion,
            config_name: input.configName,
            base_sha: input.baseSha,
            task_ids: [...input.taskIds],
            configuration_ids: input.configurations.map((c) => c.id),
            runs_per_task: input.runsPerTask,
            budget_usd: input.budgetUsd,
            started_by: input.startedBy,
            plan_id: input.plan?.id ?? null,
            plan_version: input.plan?.version ?? null,
            task_set_kind: input.taskSetKind ?? 'folder',
            task_set_commit: input.taskSetCommit ?? null,
            approved_tasks_at_start: Number(approved.n),
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        const runs = input.configurations.flatMap((configuration) =>
          input.taskIds.flatMap((taskId) =>
            Array.from({ length: input.runsPerTask }, (_, i) => ({
              tenant_id: this.tenantId,
              evaluation_id: evaluation.id,
              configuration_id: configuration.id,
              task_id: taskId,
              run_index: i + 1,
              model: configuration.model,
              provider_type: configuration.providerType,
              agent_version: configuration.agentVersion,
              max_iterations: configuration.maxIterations,
              max_duration_min: configuration.maxDurationMin,
              base_sha: input.taskBaseShas?.[taskId] ?? null,
            })),
          ),
        );
        for (let from = 0; from < runs.length; from += 1000) {
          await db
            .insertInto('evaluation_runs')
            .values(runs.slice(from, from + 1000))
            .execute();
        }
        if (input.plan) {
          await db
            .insertInto('evaluation_configurations')
            .values(
              input.configurations.map((c) => ({
                tenant_id: this.tenantId,
                evaluation_id: evaluation.id,
                configuration_id: c.id,
                agent_id: c.agentId ?? null,
                model: c.model,
                provider_type: c.providerType,
                agent_version: c.agentVersion,
                max_iterations: c.maxIterations,
                max_duration_min: c.maxDurationMin,
                instructions_path: c.instructions?.path ?? null,
                instructions_commit: c.instructions?.commit ?? null,
                instructions_sha256: c.instructions?.sha256 ?? null,
                ...fingerprintColumns(c),
              })),
            )
            .execute();
        }
        const audit = new AuditLogRepository(db, this.tenantId);
        await audit.append({
          action: 'evaluation.started',
          actorType: input.startedBy === null ? 'system' : 'human',
          actorId: input.startedBy,
          entityId: evaluation.id,
          payload: {
            project_id: input.projectId,
            code,
            data_class: input.dataClass,
            ...(input.taskSetVersion === null ? {} : { task_set_version: input.taskSetVersion }),
            ...(input.taskSetCommit === undefined
              ? {}
              : { task_set_kind: 'project', task_set_commit: input.taskSetCommit }),
            ...(input.configName === null ? {} : { config_name: input.configName }),
            runs_total: runs.length,
            budget_usd: fromMicros(toMicros(input.budgetUsd)),
            ...(input.plan ? { plan_id: input.plan.id, plan_version: input.plan.version } : {}),
          },
        });
        if (input.plan) {
          await audit.append({
            action: 'evaluation_plan.run_started',
            actorType: input.startedBy === null ? 'system' : 'human',
            actorId: input.startedBy,
            entityId: input.plan.id,
            payload: {
              evaluation_id: evaluation.id,
              version: input.plan.version,
              reason: input.plan.reason,
              budget_usd: fromMicros(toMicros(input.budgetUsd)),
            },
          });
        }
        return evaluation;
      }),
    );
  }

  /** L05: the configurations an evaluation of a plan runs (none for an operator evaluation). */
  async configurations(evaluationId: string): Promise<EvaluationConfigurationRow[]> {
    if (!isUuid(evaluationId)) return [];
    return this.run(
      this.db
        .selectFrom('evaluation_configurations')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('evaluation_id', '=', evaluationId)
        .orderBy('configuration_id')
        .execute(),
    );
  }

  async getById(id: string): Promise<Evaluation | undefined> {
    if (!isUuid(id)) return undefined;
    return this.run(
      this.db
        .selectFrom('evaluations')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .executeTakeFirst(),
    );
  }

  async getByCode(code: string): Promise<Evaluation | undefined> {
    return this.run(
      this.db
        .selectFrom('evaluations')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('code', '=', code)
        .executeTakeFirst(),
    );
  }

  /** The tenant's evaluations, newest first. */
  async list(filter: { projectId?: string; limit: number }): Promise<Evaluation[]> {
    return this.run(
      this.db
        .selectFrom('evaluations')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .$if(filter.projectId !== undefined, (qb) =>
          qb.where('project_id', '=', filter.projectId ?? ''),
        )
        .orderBy('created_at', 'desc')
        .orderBy('id')
        .limit(filter.limit)
        .execute(),
    );
  }

  /**
   * Evaluations of the given projects that ended at or after `since`, newest first (the notice of
   * task L06, QUESTIONS #482). An empty project list gives none.
   */
  async listEndedSince(filter: {
    readonly projectIds: readonly string[];
    readonly since: Date;
    readonly limit: number;
  }): Promise<Evaluation[]> {
    if (filter.projectIds.length === 0) return [];
    return this.run(
      this.db
        .selectFrom('evaluations')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('project_id', 'in', [...filter.projectIds])
        .where('finished_at', '>=', filter.since)
        .orderBy('finished_at', 'desc')
        .orderBy('id')
        .limit(filter.limit)
        .execute(),
    );
  }

  /** Evaluations that are not final: what the loop works on, oldest first. */
  async listOpen(limit: number): Promise<Evaluation[]> {
    return this.run(
      this.db
        .selectFrom('evaluations')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('status', 'in', ['queued', 'running'])
        .orderBy('created_at')
        .orderBy('id')
        .limit(limit)
        .execute(),
    );
  }

  /** `queued` → `running` when the first run starts. False when it was not `queued`. */
  async markRunning(id: string): Promise<boolean> {
    if (!isUuid(id)) return false;
    const result = await this.run(
      this.db
        .updateTable('evaluations')
        .set({ status: 'running', updated_at: sql<Date>`now()` })
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .where('status', '=', 'queued')
        .executeTakeFirst(),
    );
    return Number(result.numUpdatedRows) === 1;
  }

  /** What the evaluation's runs are doing, by status. */
  async counts(id: string): Promise<EvaluationCounts> {
    const rows = await this.run(
      this.db
        .selectFrom('evaluation_runs')
        .select(['status', (eb) => eb.fn.countAll<string>().as('n')])
        .where('tenant_id', '=', this.tenantId)
        .where('evaluation_id', '=', id)
        .groupBy('status')
        .execute(),
    );
    const counts: Record<EvaluationRunStatus, number> = {
      queued: 0,
      running: 0,
      preempted: 0,
      scored: 0,
      failed: 0,
      cancelled: 0,
    };
    for (const row of rows) counts[row.status] = Number(row.n);
    return counts;
  }

  /** The cost of the evaluation so far, as a decimal string (the base of its budget). */
  async spentUsd(id: string): Promise<string> {
    const row = await this.run(
      this.db
        .selectFrom('cost_records as cr')
        .innerJoin('evaluation_runs as er', (join) =>
          join
            .onRef('er.tenant_id', '=', 'cr.tenant_id')
            .onRef('er.id', '=', 'cr.evaluation_run_id')
            .on('er.tenant_id', '=', this.tenantId),
        )
        .select((eb) => eb.fn.coalesce(eb.fn.sum<string>('cr.cost_usd'), eb.val('0')).as('total'))
        .where('cr.tenant_id', '=', this.tenantId)
        .where('er.evaluation_id', '=', id)
        .executeTakeFirstOrThrow(),
    );
    return fromMicros(toMicros(String(row.total)));
  }

  /**
   * Ends the evaluation once with a final status and a stop reason code, and writes
   * `evaluation.finished` with the counts of its runs and its cost. Returns undefined when it was
   * final already (nothing changes, nothing is written twice).
   */
  async finish(
    id: string,
    status: Extract<EvaluationStatus, 'completed' | 'stopped_budget' | 'cancelled' | 'failed'>,
    stopReason: string | null,
  ): Promise<Evaluation | undefined> {
    if (!isUuid(id)) return undefined;
    if (!EVALUATION_FINAL_STATUSES.includes(status)) invalid('status');
    if (stopReason !== null && !CODE.test(stopReason)) invalid('stopReason');
    return this.run(
      this.transactional(async (db) => {
        const updated = await db
          .updateTable('evaluations')
          .set({
            status,
            stop_reason: stopReason,
            finished_at: sql<Date>`now()`,
            updated_at: sql<Date>`now()`,
          })
          .where('tenant_id', '=', this.tenantId)
          .where('id', '=', id)
          .where('status', 'in', ['queued', 'running'])
          .returningAll()
          .executeTakeFirst();
        if (!updated) return undefined;
        const scoped = new EvaluationRepository(db, this.tenantId);
        const counts = await scoped.counts(id);
        await new AuditLogRepository(db, this.tenantId).append({
          action: 'evaluation.finished',
          actorType: 'system',
          actorId: null,
          entityId: id,
          payload: {
            status,
            ...(stopReason === null ? {} : { stop_reason: stopReason }),
            runs_scored: counts.scored,
            runs_failed: counts.failed,
            runs_cancelled: counts.cancelled,
            cost_usd: await scoped.spentUsd(id),
          },
        });
        return updated;
      }),
    );
  }

  /** Highest number used this year by the tenant, 0 when none. Call with the code lock held. */
  private async lastNumber(db: Kysely<Database>, year: number): Promise<number> {
    const row = await db
      .selectFrom('evaluations')
      .select(sql<number | null>`max(substring(code from 11)::int)`.as('last'))
      .where('tenant_id', '=', this.tenantId)
      .where('code', 'like', `EVAL-${String(year)}-%`)
      .executeTakeFirst();
    return row?.last ?? 0;
  }
}
