// Evaluation plans (task L05, design/D-05 section 6.9, design/ADR-M82 §2.1–§2.5, migration 0031).
//
// - A plan belongs to a project; its versions are append-only. `create` writes the plan, version 1
//   and `evaluation_plan.created`; `addVersion` writes the next version under the plan's lock (a
//   stale `expectedVersion` is refused) and `evaluation_plan.changed`; `archive` is final.
// - The state of a plan (paused, the next scheduled run, the fleet hash it saw) changes with
//   conditional updates. The database refuses changes to fixed columns and to an archived plan
//   (trigger SDA23).
// - Every value is a code, an ID, a number, a decimal or a hash. A configuration's prompt variant
//   is a repository path with the commit and SHA-256 it had; never its text.
import { sql, type Kysely } from 'kysely';

import { fromMicros, isUsd, toMicros } from '../../cost/money.js';
import { DbError } from '../errors.js';
import type { Database, Evaluation, EvaluationPlan, EvaluationPlanVersion } from '../schema.js';
import { isUuid } from '../tenant-id.js';
import {
  AGENT_KEY_PATTERN,
  DATA_CLASSES,
  PROVIDER_TYPES,
  type DataClass,
  type ProviderType,
} from '@sdlc/contracts';
import {
  EVALUATION_PLAN_TRIGGERS,
  type EvaluationPlanTrigger,
  type TaskSetKind,
} from '../vocabulary.js';
import { AuditLogRepository } from './audit-log.js';
import { TenantRepository } from './base.js';

const PLAN_CODE = /^[a-z][a-z0-9-]{0,47}$/;
const CODE = /^[a-z][a-z0-9_.-]{0,63}$/;
const CONFIG_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const AGENT_KEY = AGENT_KEY_PATTERN;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;
const PATH = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+){0,15}$/;
const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** A prompt variant as stored: where the file is and what it was when the plan was saved. */
export interface PlanPromptVariant {
  readonly path: string;
  readonly commit: string;
  readonly sha256: string;
}

/**
 * One configuration of a plan: an agent of the register (its current version and model when a run
 * starts) or a model by name with the project's default agent, the caps, and an optional prompt
 * variant (QUESTIONS #475).
 */
export interface PlanConfiguration {
  readonly id: string;
  readonly agent_key: string | null;
  readonly model: string | null;
  readonly provider_type: ProviderType | null;
  readonly max_iterations: number;
  readonly max_duration_min: number;
  readonly prompt: PlanPromptVariant | null;
}

export interface PlanSchedule {
  readonly every: 'daily' | 'weekly';
  /** 0–23, UTC. */
  readonly hour: number;
  /** 1 (Monday) – 7 (Sunday), weekly only. */
  readonly weekday: number | null;
}

/** The content of one version. */
export interface PlanContent {
  readonly dataClass: DataClass;
  /** L07 (ADR-M85 §2.10): default `folder`; a `project` plan runs the project's approved tasks. */
  readonly taskSetKind?: TaskSetKind;
  /** The number of a `folder` task set; null for `project`. */
  readonly taskSetVersion: number | null;
  /** Null: every task of the set. */
  readonly taskIds: readonly string[] | null;
  readonly runsPerTask: number;
  readonly budgetPerRunUsd: string;
  readonly monthlyCapUsd: string;
  readonly trigger: EvaluationPlanTrigger;
  readonly schedule: PlanSchedule | null;
  readonly configurations: readonly PlanConfiguration[];
}

export interface NewEvaluationPlan {
  readonly projectId: string;
  readonly code: string;
  readonly content: PlanContent;
  readonly createdBy: string | null;
  readonly nextRunAt: Date | null;
  readonly seenSha256: string | null;
}

export interface PlanVersionView extends PlanContent {
  readonly version: number;
  readonly changedBy: string | null;
  readonly createdAt: Date;
}

function invalid(field: string): never {
  throw new DbError('invalid_value', `evaluation plan: ${field} is not valid`);
}

const isInt = (value: unknown, min: number, max: number): boolean =>
  Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;

/** Checks the content of a version; throws `DbError('invalid_value')`. Exported for tests. */
export function checkPlanContent(c: PlanContent): void {
  if (!(DATA_CLASSES as readonly string[]).includes(c.dataClass)) invalid('dataClass');
  if (c.dataClass === 'prohibited') invalid('dataClass');
  if ((c.taskSetKind ?? 'folder') === 'folder') {
    if (!isInt(c.taskSetVersion, 1, 1000)) invalid('taskSetVersion');
  } else if (c.taskSetKind !== 'project' || c.taskSetVersion !== null) {
    invalid('taskSetKind');
  }
  if (c.taskIds !== null) {
    if (c.taskIds.length < 1 || c.taskIds.length > 64) invalid('taskIds');
    if (new Set(c.taskIds).size !== c.taskIds.length) invalid('taskIds');
    for (const id of c.taskIds) if (!CODE.test(id)) invalid('taskIds');
  }
  if (!isInt(c.runsPerTask, 1, 20)) invalid('runsPerTask');
  if (!isUsd(c.budgetPerRunUsd) || toMicros(c.budgetPerRunUsd) <= 0n) invalid('budgetPerRunUsd');
  if (!isUsd(c.monthlyCapUsd) || toMicros(c.monthlyCapUsd) < toMicros(c.budgetPerRunUsd)) {
    invalid('monthlyCapUsd');
  }
  if (!(EVALUATION_PLAN_TRIGGERS as readonly string[]).includes(c.trigger)) invalid('trigger');
  if ((c.trigger === 'schedule') !== (c.schedule !== null)) invalid('schedule');
  if (c.schedule) {
    if (c.schedule.every !== 'daily' && c.schedule.every !== 'weekly') invalid('schedule');
    if (!isInt(c.schedule.hour, 0, 23)) invalid('schedule');
    if ((c.schedule.every === 'weekly') !== (c.schedule.weekday !== null)) invalid('schedule');
    if (c.schedule.weekday !== null && !isInt(c.schedule.weekday, 1, 7)) invalid('schedule');
  }
  if (c.configurations.length < 1 || c.configurations.length > 16) invalid('configurations');
  if (new Set(c.configurations.map((x) => x.id)).size !== c.configurations.length) {
    invalid('configurations');
  }
  for (const x of c.configurations) {
    if (!CONFIG_ID.test(x.id)) invalid('configuration id');
    if ((x.agent_key === null) === (x.model === null)) invalid('configuration source');
    if (x.agent_key !== null && !AGENT_KEY.test(x.agent_key)) invalid('agent_key');
    if (x.model !== null) {
      if (!MODEL.test(x.model)) invalid('model');
      if (!(PROVIDER_TYPES as readonly string[]).includes(x.provider_type ?? '')) {
        invalid('provider_type');
      }
    } else if (x.provider_type !== null) {
      invalid('provider_type');
    }
    if (!isInt(x.max_iterations, 1, 200)) invalid('max_iterations');
    if (!isInt(x.max_duration_min, 1, 120)) invalid('max_duration_min');
    if (x.prompt !== null) {
      if (!PATH.test(x.prompt.path) || x.prompt.path.split('/').some((s) => /^\.+$/.test(s))) {
        invalid('prompt path');
      }
      if (!SHA1.test(x.prompt.commit)) invalid('prompt commit');
      if (!SHA256.test(x.prompt.sha256)) invalid('prompt sha256');
    }
  }
}

/** The JSON stored for the configurations: exactly the declared keys, in a fixed order. */
function configurationsJson(configurations: readonly PlanConfiguration[]): string {
  return JSON.stringify(
    configurations.map((x) => ({
      id: x.id,
      agent_key: x.agent_key,
      model: x.model,
      provider_type: x.provider_type,
      max_iterations: x.max_iterations,
      max_duration_min: x.max_duration_min,
      prompt: x.prompt && { path: x.prompt.path, commit: x.prompt.commit, sha256: x.prompt.sha256 },
    })),
  );
}

function versionRow(c: PlanContent) {
  return {
    data_class: c.dataClass,
    task_set_kind: c.taskSetKind ?? 'folder',
    task_set_version: c.taskSetVersion,
    task_ids: c.taskIds === null ? null : [...c.taskIds],
    runs_per_task: c.runsPerTask,
    budget_per_run_usd: c.budgetPerRunUsd,
    monthly_cap_usd: c.monthlyCapUsd,
    trigger: c.trigger,
    schedule_every: c.schedule?.every ?? null,
    schedule_hour: c.schedule?.hour ?? null,
    schedule_weekday: c.schedule?.weekday ?? null,
    configurations: configurationsJson(c.configurations),
  };
}

/** A stored version as content. */
export function planVersionView(row: EvaluationPlanVersion): PlanVersionView {
  return {
    version: row.version,
    dataClass: row.data_class,
    taskSetKind: row.task_set_kind,
    taskSetVersion: row.task_set_version,
    taskIds: row.task_ids,
    runsPerTask: row.runs_per_task,
    budgetPerRunUsd: fromMicros(toMicros(String(row.budget_per_run_usd))),
    monthlyCapUsd: fromMicros(toMicros(String(row.monthly_cap_usd))),
    trigger: row.trigger,
    schedule:
      row.schedule_every === null || row.schedule_hour === null
        ? null
        : { every: row.schedule_every, hour: row.schedule_hour, weekday: row.schedule_weekday },
    configurations: row.configurations as PlanConfiguration[],
    changedBy: row.changed_by,
    createdAt: row.created_at,
  };
}

const usd = (value: string): string => fromMicros(toMicros(value));

export class EvaluationPlanRepository extends TenantRepository {
  /** Writes the plan, its version 1 and `evaluation_plan.created`, in one transaction. */
  async create(input: NewEvaluationPlan): Promise<EvaluationPlan> {
    if (!isUuid(input.projectId)) invalid('projectId');
    if (!PLAN_CODE.test(input.code)) invalid('code');
    if (input.createdBy !== null && !isUuid(input.createdBy)) invalid('createdBy');
    if (input.seenSha256 !== null && !SHA256.test(input.seenSha256)) invalid('seenSha256');
    checkPlanContent(input.content);
    return this.run(
      this.transactional(async (db) => {
        const plan = await db
          .insertInto('evaluation_plans')
          .values({
            tenant_id: this.tenantId,
            project_id: input.projectId,
            code: input.code,
            next_run_at: input.nextRunAt,
            seen_sha256: input.seenSha256,
            created_by: input.createdBy,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await db
          .insertInto('evaluation_plan_versions')
          .values({
            tenant_id: this.tenantId,
            plan_id: plan.id,
            version: 1,
            ...versionRow(input.content),
            changed_by: input.createdBy,
          })
          .execute();
        await new AuditLogRepository(db, this.tenantId).append({
          action: 'evaluation_plan.created',
          actorType: input.createdBy === null ? 'system' : 'human',
          actorId: input.createdBy,
          entityId: plan.id,
          payload: {
            project_id: input.projectId,
            code: input.code,
            version: 1,
            trigger: input.content.trigger,
            budget_per_run_usd: usd(input.content.budgetPerRunUsd),
            monthly_cap_usd: usd(input.content.monthlyCapUsd),
            configurations: input.content.configurations.length,
          },
        });
        return plan;
      }),
    );
  }

  /**
   * Writes the next version when the plan is still at `expectedVersion` and not archived; moves
   * the plan to it, sets its next scheduled run, and writes `evaluation_plan.changed` with the
   * changed field names. Returns undefined when the plan moved or is archived.
   */
  async addVersion(input: {
    readonly planId: string;
    readonly expectedVersion: number;
    readonly content: PlanContent;
    readonly changedBy: string;
    readonly changedFields: readonly string[];
    readonly nextRunAt: Date | null;
  }): Promise<EvaluationPlan | undefined> {
    if (!isUuid(input.planId)) return undefined;
    if (!isUuid(input.changedBy)) invalid('changedBy');
    for (const field of input.changedFields) if (!CODE.test(field)) invalid('changedFields');
    checkPlanContent(input.content);
    return this.run(
      this.transactional(async (db) => {
        const plan = await this.lock(db, input.planId);
        if (plan?.status === undefined || plan.status === 'archived') return undefined;
        if (plan.current_version !== input.expectedVersion) return undefined;
        const before = await this.versionIn(db, plan.id, plan.current_version);
        const version = plan.current_version + 1;
        await db
          .insertInto('evaluation_plan_versions')
          .values({
            tenant_id: this.tenantId,
            plan_id: plan.id,
            version,
            ...versionRow(input.content),
            changed_by: input.changedBy,
          })
          .execute();
        const updated = await db
          .updateTable('evaluation_plans')
          .set({
            current_version: version,
            next_run_at: input.nextRunAt,
            updated_at: sql<Date>`now()`,
          })
          .where('tenant_id', '=', this.tenantId)
          .where('id', '=', plan.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await new AuditLogRepository(db, this.tenantId).append({
          action: 'evaluation_plan.changed',
          actorType: 'human',
          actorId: input.changedBy,
          entityId: plan.id,
          payload: {
            version,
            fields: [...input.changedFields],
            trigger: input.content.trigger,
            old_budget_per_run_usd: usd(String(before!.budget_per_run_usd)),
            budget_per_run_usd: usd(input.content.budgetPerRunUsd),
            old_monthly_cap_usd: usd(String(before!.monthly_cap_usd)),
            monthly_cap_usd: usd(input.content.monthlyCapUsd),
          },
        });
        return updated;
      }),
    );
  }

  /** Archives the plan (final) and writes `evaluation_plan.archived`. Undefined if archived. */
  async archive(planId: string, by: string): Promise<EvaluationPlan | undefined> {
    if (!isUuid(planId)) return undefined;
    if (!isUuid(by)) invalid('by');
    return this.run(
      this.transactional(async (db) => {
        const updated = await db
          .updateTable('evaluation_plans')
          .set({
            status: 'archived',
            run_requested_at: null,
            run_requested_by: null,
            pause_reason: null,
            paused_until: null,
            next_run_at: null,
            updated_at: sql<Date>`now()`,
          })
          .where('tenant_id', '=', this.tenantId)
          .where('id', '=', planId)
          .where('status', '!=', 'archived')
          .returningAll()
          .executeTakeFirst();
        if (!updated) return undefined;
        await new AuditLogRepository(db, this.tenantId).append({
          action: 'evaluation_plan.archived',
          actorType: 'human',
          actorId: by,
          entityId: planId,
          payload: { version: updated.current_version },
        });
        return updated;
      }),
    );
  }

  /**
   * Pauses an active plan until `until` with a reason code, and writes `evaluation_plan.paused`.
   * False when it was not active.
   */
  async pause(planId: string, reason: string, until: Date | null): Promise<boolean> {
    if (!isUuid(planId)) return false;
    if (!CODE.test(reason)) invalid('reason');
    return this.run(
      this.transactional(async (db) => {
        const updated = await db
          .updateTable('evaluation_plans')
          .set({
            status: 'paused',
            pause_reason: reason,
            paused_until: until,
            updated_at: sql<Date>`now()`,
          })
          .where('tenant_id', '=', this.tenantId)
          .where('id', '=', planId)
          .where('status', '=', 'active')
          .executeTakeFirst();
        if (Number(updated.numUpdatedRows) !== 1) return false;
        await new AuditLogRepository(db, this.tenantId).append({
          action: 'evaluation_plan.paused',
          actorType: 'system',
          actorId: null,
          entityId: planId,
          payload: { reason },
        });
        return true;
      }),
    );
  }

  /**
   * Records a person's Run now (QUESTIONS #476) and writes `evaluation_plan.run_requested`. False
   * when the plan is not active or a request waits already.
   */
  async requestRun(planId: string, by: string): Promise<boolean> {
    if (!isUuid(planId)) return false;
    if (!isUuid(by)) invalid('by');
    return this.run(
      this.transactional(async (db) => {
        const updated = await db
          .updateTable('evaluation_plans')
          .set({
            run_requested_at: sql<Date>`now()`,
            run_requested_by: by,
            last_refusal: null,
            last_refusal_at: null,
            updated_at: sql<Date>`now()`,
          })
          .where('tenant_id', '=', this.tenantId)
          .where('id', '=', planId)
          .where('status', '=', 'active')
          .where('run_requested_at', 'is', null)
          .returning('current_version')
          .executeTakeFirst();
        if (!updated) return false;
        await new AuditLogRepository(db, this.tenantId).append({
          action: 'evaluation_plan.run_requested',
          actorType: 'human',
          actorId: by,
          entityId: planId,
          payload: { version: updated.current_version },
        });
        return true;
      }),
    );
  }

  /** The worker took the request: it is cleared, started or refused. */
  async clearRequest(planId: string): Promise<boolean> {
    if (!isUuid(planId)) return false;
    const result = await this.run(
      this.db
        .updateTable('evaluation_plans')
        .set({ run_requested_at: null, run_requested_by: null, updated_at: sql<Date>`now()` })
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', planId)
        .where('run_requested_at', 'is not', null)
        .executeTakeFirst(),
    );
    return Number(result.numUpdatedRows) === 1;
  }

  /** The worker could not start the plan: the code stays on the plan, and in the audit log. */
  async recordRefusal(planId: string, reason: string): Promise<boolean> {
    if (!isUuid(planId)) return false;
    if (!CODE.test(reason)) invalid('reason');
    return this.run(
      this.transactional(async (db) => {
        const updated = await db
          .updateTable('evaluation_plans')
          .set({
            last_refusal: reason,
            last_refusal_at: sql<Date>`now()`,
            updated_at: sql<Date>`now()`,
          })
          .where('tenant_id', '=', this.tenantId)
          .where('id', '=', planId)
          .where('status', '!=', 'archived')
          .returning('current_version')
          .executeTakeFirst();
        if (!updated) return false;
        await new AuditLogRepository(db, this.tenantId).append({
          action: 'evaluation_plan.run_refused',
          actorType: 'system',
          actorId: null,
          entityId: planId,
          payload: { version: updated.current_version, reason },
        });
        return true;
      }),
    );
  }

  /** The plan's evaluations, newest first (at most `limit`). */
  async evaluations(planId: string, limit: number): Promise<Evaluation[]> {
    if (!isUuid(planId)) return [];
    return this.run(
      this.db
        .selectFrom('evaluations')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('plan_id', '=', planId)
        .orderBy('created_at', 'desc')
        .limit(limit)
        .execute(),
    );
  }

  /** A paused plan becomes active again (the month turned, or a new cap). False otherwise. */
  async resume(planId: string): Promise<boolean> {
    if (!isUuid(planId)) return false;
    const result = await this.run(
      this.db
        .updateTable('evaluation_plans')
        .set({
          status: 'active',
          pause_reason: null,
          paused_until: null,
          updated_at: sql<Date>`now()`,
        })
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', planId)
        .where('status', '=', 'paused')
        .executeTakeFirst(),
    );
    return Number(result.numUpdatedRows) === 1;
  }

  /** Sets the next scheduled run and, for `on_change`, the fleet hash the plan has seen. */
  async setSchedule(
    planId: string,
    state: { readonly nextRunAt?: Date | null; readonly seenSha256?: string | null },
  ): Promise<boolean> {
    if (!isUuid(planId)) return false;
    if (state.seenSha256 != null && !SHA256.test(state.seenSha256)) invalid('seenSha256');
    const result = await this.run(
      this.db
        .updateTable('evaluation_plans')
        .set({
          ...(state.nextRunAt === undefined ? {} : { next_run_at: state.nextRunAt }),
          ...(state.seenSha256 === undefined ? {} : { seen_sha256: state.seenSha256 }),
          updated_at: sql<Date>`now()`,
        })
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', planId)
        .where('status', '!=', 'archived')
        .executeTakeFirst(),
    );
    return Number(result.numUpdatedRows) === 1;
  }

  async getById(id: string): Promise<EvaluationPlan | undefined> {
    if (!isUuid(id)) return undefined;
    return this.run(
      this.db
        .selectFrom('evaluation_plans')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .executeTakeFirst(),
    );
  }

  async getByCode(projectId: string, code: string): Promise<EvaluationPlan | undefined> {
    if (!isUuid(projectId) || !PLAN_CODE.test(code)) return undefined;
    return this.run(
      this.db
        .selectFrom('evaluation_plans')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('project_id', '=', projectId)
        .where('code', '=', code)
        .executeTakeFirst(),
    );
  }

  /** The plans of the tenant that are not archived: what the worker's plan loop looks at. */
  async listOpen(limit: number): Promise<EvaluationPlan[]> {
    return this.run(
      this.db
        .selectFrom('evaluation_plans')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('status', '!=', 'archived')
        .orderBy('created_at')
        .orderBy('id')
        .limit(limit)
        .execute(),
    );
  }

  /** The plans of a project, archived last, then by code. */
  async listForProject(projectId: string): Promise<EvaluationPlan[]> {
    if (!isUuid(projectId)) return [];
    return this.run(
      this.db
        .selectFrom('evaluation_plans')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('project_id', '=', projectId)
        .orderBy(sql`status = 'archived'`)
        .orderBy('code')
        .execute(),
    );
  }

  async getVersion(planId: string, version: number): Promise<PlanVersionView | undefined> {
    if (!isUuid(planId)) return undefined;
    const row = await this.run(this.versionIn(this.db, planId, version));
    return row && planVersionView(row);
  }

  async listVersions(planId: string): Promise<PlanVersionView[]> {
    if (!isUuid(planId)) return [];
    const rows = await this.run(
      this.db
        .selectFrom('evaluation_plan_versions')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('plan_id', '=', planId)
        .orderBy('version')
        .execute(),
    );
    return rows.map(planVersionView);
  }

  /** What the plan's evaluations cost since `since` (the start of the UTC month), a decimal. */
  async spentSince(planId: string, since: Date): Promise<string> {
    if (!isUuid(planId)) return '0';
    const row = await this.run(
      this.db
        .selectFrom('cost_records as cr')
        .innerJoin('evaluation_runs as er', (join) =>
          join
            .onRef('er.tenant_id', '=', 'cr.tenant_id')
            .onRef('er.id', '=', 'cr.evaluation_run_id')
            .on('er.tenant_id', '=', this.tenantId),
        )
        .innerJoin('evaluations as e', (join) =>
          join
            .onRef('e.tenant_id', '=', 'er.tenant_id')
            .onRef('e.id', '=', 'er.evaluation_id')
            .on('e.tenant_id', '=', this.tenantId),
        )
        .select((eb) => eb.fn.coalesce(eb.fn.sum<string>('cr.cost_usd'), eb.val('0')).as('total'))
        .where('cr.tenant_id', '=', this.tenantId)
        .where('e.plan_id', '=', planId)
        .where('cr.occurred_at', '>=', since)
        .executeTakeFirstOrThrow(),
    );
    return fromMicros(toMicros(String(row.total)));
  }

  /** The plan's evaluation that is not final, if any (at most one, a unique index). */
  async openEvaluationId(planId: string): Promise<string | undefined> {
    if (!isUuid(planId)) return undefined;
    const row = await this.run(
      this.db
        .selectFrom('evaluations')
        .select('id')
        .where('tenant_id', '=', this.tenantId)
        .where('plan_id', '=', planId)
        .where('status', 'in', ['queued', 'running'])
        .executeTakeFirst(),
    );
    return row?.id;
  }

  private lock(db: Kysely<Database>, planId: string): Promise<EvaluationPlan | undefined> {
    return db
      .selectFrom('evaluation_plans')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', planId)
      .forUpdate()
      .executeTakeFirst();
  }

  private versionIn(
    db: Kysely<Database>,
    planId: string,
    version: number,
  ): Promise<EvaluationPlanVersion | undefined> {
    return db
      .selectFrom('evaluation_plan_versions')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('plan_id', '=', planId)
      .where('version', '=', version)
      .executeTakeFirst();
  }
}
