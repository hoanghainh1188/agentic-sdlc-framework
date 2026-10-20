// A project's own evaluation tasks (task L07, design/D-05 section 6.10, design/ADR-M85 §2.6–§2.8,
// migration 0033).
//
// - A task is a reference to its card on the default branch: path, commit, SHA-256, the intent,
//   the base and merge commits. `register` writes a new task, or takes a changed card of the same
//   task back to `registered` (a new check and a new review); an unchanged card changes nothing.
// - `decide` writes a review decision (append-only, bound to the card's SHA-256) and moves the task
//   to `approved` or `rejected`, under a conditional update: a task that changed since the caller
//   read it is refused.
// - Codes, IDs and hashes only: never the card's content, the spec, a test or a diff.
import { DbError } from '../errors.js';
import type { EvaluationTask, EvaluationTaskDecisionRow } from '../schema.js';
import { isUuid } from '../tenant-id.js';
import {
  EVALUATION_TASK_REJECT_REASONS,
  type EvaluationTaskDecision,
  type EvaluationTaskRejectReason,
  type EvaluationTaskStatus,
} from '../vocabulary.js';
import { AuditLogRepository } from './audit-log.js';
import { TenantRepository } from './base.js';

const TASK_ID = /^[a-z][a-z0-9-]{1,47}$/;
const CODE = /^[a-z][a-z0-9_.-]{0,63}$/;
const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function invalid(field: string): never {
  throw new DbError('invalid_value', `evaluation task: ${field} is not valid`);
}

export interface NewEvaluationTask {
  readonly projectId: string;
  readonly taskId: string;
  readonly intentId: string;
  readonly cardCommit: string;
  readonly cardSha256: string;
  readonly baseCommit: string;
  readonly mergeCommit: string;
  /** The person who registered it; null for the operator. */
  readonly registeredBy: string | null;
}

export interface TaskDecisionInput {
  readonly taskId: string;
  /** The card the reviewer saw: the decision is bound to it. */
  readonly cardSha256: string;
  readonly decision: EvaluationTaskDecision;
  readonly reason: EvaluationTaskRejectReason | null;
  readonly decidedBy: string;
}

export type RegisterOutcome = 'created' | 'changed' | 'unchanged';

export function cardPathOf(taskId: string): string {
  return `.sdlc/eval-tasks/${taskId}.yaml`;
}

export class EvaluationTaskRepository extends TenantRepository {
  /**
   * Registers a card (ADR-M85 §2.2 step 5) and writes `evaluation_task.registered` when something
   * changed. The same task ID with another intent is a conflict; a `gone` task stays gone.
   */
  async register(
    input: NewEvaluationTask,
  ): Promise<{ task: EvaluationTask; outcome: RegisterOutcome }> {
    if (!isUuid(input.projectId)) invalid('projectId');
    if (!TASK_ID.test(input.taskId)) invalid('taskId');
    if (!isUuid(input.intentId)) invalid('intentId');
    for (const field of ['cardCommit', 'baseCommit', 'mergeCommit'] as const) {
      if (!SHA1.test(input[field])) invalid(field);
    }
    if (!SHA256.test(input.cardSha256)) invalid('cardSha256');
    if (input.baseCommit === input.mergeCommit) invalid('baseCommit');
    if (input.registeredBy !== null && !isUuid(input.registeredBy)) invalid('registeredBy');
    return this.run(
      this.transactional(async (db) => {
        const existing = await db
          .selectFrom('evaluation_tasks')
          .selectAll()
          .where('tenant_id', '=', this.tenantId)
          .where('project_id', '=', input.projectId)
          .where('task_id', '=', input.taskId)
          .forUpdate()
          .executeTakeFirst();
        if (existing && existing.intent_id !== input.intentId) {
          throw new DbError('conflict', 'evaluation task: the task ID belongs to another intent');
        }
        if (existing?.status === 'gone') {
          throw new DbError('immutable', 'evaluation task: a gone task is final');
        }
        if (existing && existing.card_sha256 === input.cardSha256) {
          return { task: existing, outcome: 'unchanged' as const };
        }
        const task = existing
          ? await db
              .updateTable('evaluation_tasks')
              .set({
                card_commit: input.cardCommit,
                card_sha256: input.cardSha256,
                base_commit: input.baseCommit,
                merge_commit: input.mergeCommit,
                status: 'registered',
                check_code: null,
                updated_at: new Date(),
              })
              .where('tenant_id', '=', this.tenantId)
              .where('id', '=', existing.id)
              .returningAll()
              .executeTakeFirstOrThrow()
          : await db
              .insertInto('evaluation_tasks')
              .values({
                tenant_id: this.tenantId,
                project_id: input.projectId,
                task_id: input.taskId,
                intent_id: input.intentId,
                card_path: cardPathOf(input.taskId),
                card_commit: input.cardCommit,
                card_sha256: input.cardSha256,
                base_commit: input.baseCommit,
                merge_commit: input.mergeCommit,
                registered_by: input.registeredBy,
              })
              .returningAll()
              .executeTakeFirstOrThrow();
        await new AuditLogRepository(db, this.tenantId).append({
          action: 'evaluation_task.registered',
          actorType: input.registeredBy === null ? 'system' : 'human',
          actorId: input.registeredBy,
          entityId: task.id,
          payload: {
            project_id: input.projectId,
            task: input.taskId,
            intent_id: input.intentId,
            card_sha256: input.cardSha256,
            card_commit: input.cardCommit,
          },
        });
        return { task, outcome: existing ? ('changed' as const) : ('created' as const) };
      }),
    );
  }

  /**
   * Records the result of a task's check (PR 4's worker; tests): `checked`, or `check_failed`
   * with its code. Only a task in `registered` or `checking` for this card SHA-256 moves.
   */
  async recordCheck(
    id: string,
    cardSha256: string,
    result:
      | { readonly status: 'checking' | 'checked' }
      | { readonly status: 'check_failed'; readonly code: string },
  ): Promise<boolean> {
    if (!isUuid(id)) invalid('id');
    if (!SHA256.test(cardSha256)) invalid('cardSha256');
    const code = result.status === 'check_failed' ? result.code : null;
    if (code !== null && !CODE.test(code)) invalid('code');
    const from: EvaluationTaskStatus[] =
      result.status === 'checking' ? ['registered'] : ['registered', 'checking'];
    const updated = await this.run(
      this.db
        .updateTable('evaluation_tasks')
        .set({ status: result.status, check_code: code, updated_at: new Date() })
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .where('card_sha256', '=', cardSha256)
        .where('status', 'in', from)
        .executeTakeFirst(),
    );
    return Number(updated.numUpdatedRows) === 1;
  }

  /**
   * A review decision (ADR-M85 §2.6): the append-only row, the task's new status and
   * `evaluation_task.approved` or `.rejected`, in one transaction. Only a `checked` task with the
   * same card SHA-256 is decided; anything else is a `version_conflict`.
   */
  async decide(input: TaskDecisionInput): Promise<EvaluationTask> {
    if (!isUuid(input.taskId)) invalid('taskId');
    if (!SHA256.test(input.cardSha256)) invalid('cardSha256');
    if (!isUuid(input.decidedBy)) invalid('decidedBy');
    if (input.decision === 'approved' && input.reason !== null) invalid('reason');
    if (
      input.decision === 'rejected' &&
      (input.reason === null || !EVALUATION_TASK_REJECT_REASONS.includes(input.reason))
    ) {
      invalid('reason');
    }
    return this.run(
      this.transactional(async (db) => {
        const task = await db
          .updateTable('evaluation_tasks')
          .set({ status: input.decision, updated_at: new Date() })
          .where('tenant_id', '=', this.tenantId)
          .where('id', '=', input.taskId)
          .where('card_sha256', '=', input.cardSha256)
          .where('status', '=', 'checked')
          .returningAll()
          .executeTakeFirst();
        if (!task) {
          throw new DbError(
            'version_conflict',
            'evaluation task: not checked, or the card changed',
          );
        }
        await db
          .insertInto('evaluation_task_decisions')
          .values({
            tenant_id: this.tenantId,
            task_id: task.id,
            card_sha256: input.cardSha256,
            decision: input.decision,
            reason: input.reason,
            decided_by: input.decidedBy,
          })
          .execute();
        await new AuditLogRepository(db, this.tenantId).append({
          action: `evaluation_task.${input.decision}`,
          actorType: 'human',
          actorId: input.decidedBy,
          entityId: task.id,
          payload: {
            project_id: task.project_id,
            task: task.task_id,
            card_sha256: input.cardSha256,
            ...(input.reason === null ? {} : { reason: input.reason }),
          },
        });
        return task;
      }),
    );
  }

  async getById(id: string): Promise<EvaluationTask | undefined> {
    if (!isUuid(id)) return undefined;
    return this.run(
      this.db
        .selectFrom('evaluation_tasks')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .executeTakeFirst(),
    );
  }

  async getByTaskId(projectId: string, taskId: string): Promise<EvaluationTask | undefined> {
    if (!isUuid(projectId) || !TASK_ID.test(taskId)) return undefined;
    return this.run(
      this.db
        .selectFrom('evaluation_tasks')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('project_id', '=', projectId)
        .where('task_id', '=', taskId)
        .executeTakeFirst(),
    );
  }

  /** The tasks of a project, by task ID. */
  async listForProject(projectId: string): Promise<EvaluationTask[]> {
    if (!isUuid(projectId)) return [];
    return this.run(
      this.db
        .selectFrom('evaluation_tasks')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('project_id', '=', projectId)
        .orderBy('task_id')
        .execute(),
    );
  }

  /** The review decisions of a task, oldest first. */
  async listDecisions(taskId: string): Promise<EvaluationTaskDecisionRow[]> {
    if (!isUuid(taskId)) return [];
    return this.run(
      this.db
        .selectFrom('evaluation_task_decisions')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('task_id', '=', taskId)
        .orderBy('id')
        .execute(),
    );
  }
}
