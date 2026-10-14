// Runs of an evaluation and their results (task L04, design/ADR-M81 §2.2, §2.3; D-05 §6.8; migration
// 0029). Always for one tenant, with `tenant_id = <tenant>` on every table occurrence.
//
// - A run is `queued`, then `running`, then `scored`, `failed` or `cancelled`. A running run may be
//   `preempted` to give its slot to a real run (QUESTIONS #461); it is queued again with the next
//   attempt, and the preempted attempt has no result (it is not counted). The database refuses
//   every other move (trigger SDA22).
// - `recordResult` writes the append-only result and moves the run to `scored` in one transaction.
//   Numbers and codes only, as the run result of ADR-M78 §2.4 and the hardware block of ADR-M81.
import { sql } from 'kysely';

import { isUsd } from '../../cost/money.js';
import { DbError } from '../errors.js';
import type { EvaluationRun, EvaluationRunResultRow } from '../schema.js';
import { isUuid } from '../tenant-id.js';
import { TenantRepository } from './base.js';

const CODE = /^[a-z][a-z0-9_.-]{0,63}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const MACHINE = /^[A-Za-z0-9][A-Za-z0-9 ._:@()/+-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** The result of one scored run: the fields of `RunResult` in `@sdlc/eval`, flat. */
export interface NewEvaluationRunResult {
  readonly instructions_sha256: string;
  readonly outcome: string;
  readonly status: string;
  readonly stop_reason: string | null;
  readonly applied: boolean;
  readonly resolved: boolean;
  readonly fail_to_pass_passed: boolean;
  readonly pass_to_pass_passed: boolean;
  readonly ci_passed: boolean;
  readonly scope_breach: boolean;
  readonly out_of_plan_files: number;
  readonly lint_findings: number;
  readonly diff_files: number;
  readonly diff_lines_added: number;
  readonly diff_lines_removed: number;
  readonly seconds: number;
  readonly iterations: number;
  readonly model_calls: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cached_input_tokens: number;
  /** Decimal string, at most 6 decimals. */
  readonly cost_usd: string;
  readonly hardware: {
    readonly cpu_model: string;
    readonly cpu_cores: number;
    readonly memory_gb: number;
    readonly docker_version: string;
    readonly gpu: string | null;
    readonly runner_instance: string | null;
  };
}

const COUNTS = [
  'out_of_plan_files',
  'lint_findings',
  'diff_files',
  'diff_lines_added',
  'diff_lines_removed',
  'seconds',
  'iterations',
  'model_calls',
  'input_tokens',
  'output_tokens',
  'cached_input_tokens',
] as const satisfies readonly (keyof NewEvaluationRunResult)[];

const FLAGS = [
  'applied',
  'resolved',
  'fail_to_pass_passed',
  'pass_to_pass_passed',
  'ci_passed',
  'scope_breach',
] as const satisfies readonly (keyof NewEvaluationRunResult)[];

function invalid(field: string): never {
  throw new DbError('invalid_value', `evaluation result: ${field} is not valid`);
}

/** Checks a result before it is written; throws `DbError('invalid_value')`. Exported for tests. */
export function checkEvaluationRunResult(result: NewEvaluationRunResult): void {
  if (!SHA256.test(result.instructions_sha256)) invalid('instructions_sha256');
  if (!CODE.test(result.outcome)) invalid('outcome');
  if (!CODE.test(result.status)) invalid('status');
  if (result.stop_reason !== null && !CODE.test(result.stop_reason)) invalid('stop_reason');
  for (const flag of FLAGS) if (typeof result[flag] !== 'boolean') invalid(flag);
  for (const count of COUNTS) {
    if (!Number.isSafeInteger(result[count]) || result[count] < 0) invalid(count);
  }
  if (result.cached_input_tokens > result.input_tokens) invalid('cached_input_tokens');
  if (
    result.resolved &&
    !(result.applied && result.fail_to_pass_passed && result.pass_to_pass_passed)
  ) {
    invalid('resolved');
  }
  if (!isUsd(result.cost_usd)) invalid('cost_usd');
  const h = result.hardware;
  if (!MACHINE.test(h.cpu_model)) invalid('hardware.cpu_model');
  if (!Number.isSafeInteger(h.cpu_cores) || h.cpu_cores < 0) invalid('hardware.cpu_cores');
  if (!Number.isSafeInteger(h.memory_gb) || h.memory_gb < 0) invalid('hardware.memory_gb');
  if (!VERSION.test(h.docker_version)) invalid('hardware.docker_version');
  if (h.gpu !== null && !MACHINE.test(h.gpu)) invalid('hardware.gpu');
  if (h.runner_instance !== null && !CODE.test(h.runner_instance)) {
    invalid('hardware.runner_instance');
  }
}

export class EvaluationRunRepository extends TenantRepository {
  async getById(id: string): Promise<EvaluationRun | undefined> {
    if (!isUuid(id)) return undefined;
    return this.run(
      this.db
        .selectFrom('evaluation_runs')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .executeTakeFirst(),
    );
  }

  /** The runs of one evaluation in a fixed order: configuration, task, run number. */
  async listForEvaluation(evaluationId: string): Promise<EvaluationRun[]> {
    if (!isUuid(evaluationId)) return [];
    return this.run(
      this.db
        .selectFrom('evaluation_runs')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('evaluation_id', '=', evaluationId)
        .orderBy('configuration_id')
        .orderBy('task_id')
        .orderBy('run_index')
        .execute(),
    );
  }

  /**
   * Takes up to `limit` queued runs of open evaluations, oldest first, and moves them to
   * `running` for the runner instance (`FOR UPDATE SKIP LOCKED`: two runners never take the same
   * run). The first start of an evaluation moves it to `running` too.
   */
  async claimQueued(limit: number, runnerInstance: string): Promise<EvaluationRun[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) return [];
    if (!CODE.test(runnerInstance)) invalid('runnerInstance');
    return this.run(
      this.transactional(async (db) => {
        const picked = await db
          .selectFrom('evaluation_runs as er')
          .innerJoin('evaluations as e', (join) =>
            join
              .onRef('e.tenant_id', '=', 'er.tenant_id')
              .onRef('e.id', '=', 'er.evaluation_id')
              .on('e.tenant_id', '=', this.tenantId),
          )
          .select('er.id')
          .where('er.tenant_id', '=', this.tenantId)
          .where('er.status', '=', 'queued')
          .where('e.status', 'in', ['queued', 'running'])
          .orderBy('er.created_at')
          .orderBy('er.id')
          .limit(limit)
          .forUpdate('er')
          .skipLocked()
          .execute();
        if (picked.length === 0) return [];
        const claimed = await db
          .updateTable('evaluation_runs')
          .set({
            status: 'running',
            runner_instance: runnerInstance,
            started_at: sql<Date>`now()`,
            updated_at: sql<Date>`now()`,
          })
          .where('tenant_id', '=', this.tenantId)
          .where(
            'id',
            'in',
            picked.map((row) => row.id),
          )
          .where('status', '=', 'queued')
          .returningAll()
          .execute();
        const evaluationIds = [...new Set(claimed.map((run) => run.evaluation_id))];
        await db
          .updateTable('evaluations')
          .set({ status: 'running', updated_at: sql<Date>`now()` })
          .where('tenant_id', '=', this.tenantId)
          .where('id', 'in', evaluationIds)
          .where('status', '=', 'queued')
          .execute();
        return claimed;
      }),
    );
  }

  /**
   * Queued runs of open evaluations that have no contract for their current attempt yet: what the
   * worker's loop prepares next, oldest first (ADR-M81 §2.8).
   */
  async listToPrepare(limit: number): Promise<EvaluationRun[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) return [];
    return this.run(
      this.db
        .selectFrom('evaluation_runs as er')
        .innerJoin('evaluations as e', (join) =>
          join
            .onRef('e.tenant_id', '=', 'er.tenant_id')
            .onRef('e.id', '=', 'er.evaluation_id')
            .on('e.tenant_id', '=', this.tenantId),
        )
        .selectAll('er')
        .where('er.tenant_id', '=', this.tenantId)
        .where('er.status', '=', 'queued')
        .where('e.status', 'in', ['queued', 'running'])
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom('evaluation_run_contracts as c')
                .select('c.attempt')
                .where('c.tenant_id', '=', this.tenantId)
                .whereRef('c.evaluation_run_id', '=', 'er.id')
                .whereRef('c.attempt', '=', 'er.attempt'),
            ),
          ),
        )
        .orderBy('er.created_at')
        .orderBy('er.id')
        .limit(limit)
        .execute(),
    );
  }

  /**
   * Queued runs that have a contract for their current attempt: handed to a workflow, waiting for
   * a runner. If no workflow lives for one (the worker stopped between the contract and the
   * start), the loop gives it the next attempt.
   */
  async listHandedOver(limit: number): Promise<EvaluationRun[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) return [];
    return this.run(
      this.db
        .selectFrom('evaluation_runs as er')
        .selectAll('er')
        .where('er.tenant_id', '=', this.tenantId)
        .where('er.status', '=', 'queued')
        .where((eb) =>
          eb.exists(
            eb
              .selectFrom('evaluation_run_contracts as c')
              .select('c.attempt')
              .where('c.tenant_id', '=', this.tenantId)
              .whereRef('c.evaluation_run_id', '=', 'er.id')
              .whereRef('c.attempt', '=', 'er.attempt'),
          ),
        )
        .orderBy('er.created_at')
        .orderBy('er.id')
        .limit(limit)
        .execute(),
    );
  }

  /** Runs a runner works on, of evaluations that already ended (the workflow is cancelled). */
  async runningOfClosedEvaluations(limit: number): Promise<EvaluationRun[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) return [];
    return this.run(
      this.db
        .selectFrom('evaluation_runs as er')
        .innerJoin('evaluations as e', (join) =>
          join
            .onRef('e.tenant_id', '=', 'er.tenant_id')
            .onRef('e.id', '=', 'er.evaluation_id')
            .on('e.tenant_id', '=', this.tenantId),
        )
        .selectAll('er')
        .where('er.tenant_id', '=', this.tenantId)
        .where('er.status', '=', 'running')
        .where('e.status', 'not in', ['queued', 'running'])
        .orderBy('er.id')
        .limit(limit)
        .execute(),
    );
  }

  /** Runs that are `running`, or `queued` with a contract: how much is on its way to the runner. */
  async countInFlight(): Promise<number> {
    const row = await this.run(
      this.db
        .selectFrom('evaluation_runs as er')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('er.tenant_id', '=', this.tenantId)
        .where((eb) =>
          eb.or([
            eb('er.status', '=', 'running'),
            eb.exists(
              eb
                .selectFrom('evaluation_run_contracts as c')
                .select('c.attempt')
                .where('c.tenant_id', '=', this.tenantId)
                .whereRef('c.evaluation_run_id', '=', 'er.id')
                .whereRef('c.attempt', '=', 'er.attempt')
                .where(eb('er.status', '=', 'queued')),
            ),
          ]),
        )
        .executeTakeFirstOrThrow(),
    );
    return Number(row.n);
  }

  /**
   * The runner takes one queued run for the attempt its contract names: `queued` → `running`, with
   * one conditional update (two runners never take the same run). False when the run is not queued
   * any more, or is on another attempt. The first start of an evaluation moves it to `running`.
   */
  async claim(id: string, attempt: number, runnerInstance: string): Promise<boolean> {
    if (!isUuid(id) || !Number.isSafeInteger(attempt) || attempt < 1) return false;
    if (!CODE.test(runnerInstance)) invalid('runnerInstance');
    return this.run(
      this.transactional(async (db) => {
        const claimed = await db
          .updateTable('evaluation_runs')
          .set({
            status: 'running',
            runner_instance: runnerInstance,
            started_at: sql<Date>`now()`,
            updated_at: sql<Date>`now()`,
          })
          .where('tenant_id', '=', this.tenantId)
          .where('id', '=', id)
          .where('status', '=', 'queued')
          .where('attempt', '=', attempt)
          .returning('evaluation_id')
          .executeTakeFirst();
        if (!claimed) return false;
        await db
          .updateTable('evaluations')
          .set({ status: 'running', updated_at: sql<Date>`now()` })
          .where('tenant_id', '=', this.tenantId)
          .where('id', '=', claimed.evaluation_id)
          .where('status', '=', 'queued')
          .execute();
        return true;
      }),
    );
  }

  /**
   * A `queued` run gets the next attempt (its contract was refused, for example expired, and the
   * pair run and attempt holds only one contract). False when the run is not queued or the attempt
   * moved already.
   */
  async nextAttempt(id: string, attempt: number): Promise<boolean> {
    if (!isUuid(id) || !Number.isSafeInteger(attempt) || attempt < 1) return false;
    const result = await this.run(
      this.db
        .updateTable('evaluation_runs')
        .set({ attempt: attempt + 1, updated_at: sql<Date>`now()` })
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .where('status', '=', 'queued')
        .where('attempt', '=', attempt)
        .executeTakeFirst(),
    );
    return Number(result.numUpdatedRows) === 1;
  }

  /** `running` → `preempted`: a real run needs the slot (QUESTIONS #461). False if not running. */
  async markPreempted(id: string): Promise<boolean> {
    return this.move(id, 'running', {
      status: 'preempted',
      runner_instance: null,
      started_at: null,
    });
  }

  /** `preempted` → `queued` with the next attempt. False if the run was not preempted. */
  async requeue(id: string): Promise<boolean> {
    if (!isUuid(id)) return false;
    const result = await this.run(
      this.db
        .updateTable('evaluation_runs')
        .set({
          status: 'queued',
          attempt: sql<number>`attempt + 1`,
          runner_instance: null,
          started_at: null,
          updated_at: sql<Date>`now()`,
        })
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .where('status', '=', 'preempted')
        .executeTakeFirst(),
    );
    return Number(result.numUpdatedRows) === 1;
  }

  /** `running` → `cancelled` with a stop reason code: the evaluation stopped (no result is written). */
  async markCancelled(id: string, stopReason: string): Promise<boolean> {
    if (!CODE.test(stopReason)) invalid('stopReason');
    return this.move(id, 'running', {
      status: 'cancelled',
      stop_reason: stopReason,
      finished_at: sql<Date>`now()`,
    });
  }

  /** `running` → `failed` with a stop reason code (no result is written). */
  async markFailed(id: string, stopReason: string): Promise<boolean> {
    if (!CODE.test(stopReason)) invalid('stopReason');
    return this.move(id, 'running', {
      status: 'failed',
      stop_reason: stopReason,
      finished_at: sql<Date>`now()`,
    });
  }

  /**
   * Cancels one run no runner works on (`queued`, `preempted`) with a stop reason code: its model
   * is not allowed any more, or it could not be handed over. False if it was neither.
   */
  async cancelOne(id: string, stopReason: string): Promise<boolean> {
    if (!isUuid(id)) return false;
    if (!CODE.test(stopReason)) invalid('stopReason');
    const result = await this.run(
      this.db
        .updateTable('evaluation_runs')
        .set({
          status: 'cancelled',
          stop_reason: stopReason,
          finished_at: sql<Date>`now()`,
          updated_at: sql<Date>`now()`,
        })
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .where('status', 'in', ['queued', 'preempted'])
        .executeTakeFirst(),
    );
    return Number(result.numUpdatedRows) === 1;
  }

  /**
   * Cancels the runs of the evaluation that no runner is working on (`queued`, `preempted`) with a
   * stop reason code. Returns how many. Running runs end through their runner.
   */
  async cancelWaiting(evaluationId: string, stopReason: string): Promise<number> {
    if (!isUuid(evaluationId)) return 0;
    if (!CODE.test(stopReason)) invalid('stopReason');
    const result = await this.run(
      this.db
        .updateTable('evaluation_runs')
        .set({
          status: 'cancelled',
          stop_reason: stopReason,
          finished_at: sql<Date>`now()`,
          updated_at: sql<Date>`now()`,
        })
        .where('tenant_id', '=', this.tenantId)
        .where('evaluation_id', '=', evaluationId)
        .where('status', 'in', ['queued', 'preempted'])
        .executeTakeFirst(),
    );
    return Number(result.numUpdatedRows);
  }

  /**
   * Writes the result of a `running` run and moves it to `scored`, in one transaction. Fails when
   * the run is not running (a preempted or cancelled attempt has no result) or already has one.
   */
  async recordResult(id: string, result: NewEvaluationRunResult): Promise<EvaluationRunResultRow> {
    checkEvaluationRunResult(result);
    if (!isUuid(id)) invalid('id');
    return this.run(
      this.transactional(async (db) => {
        const run = await db
          .selectFrom('evaluation_runs')
          .selectAll()
          .where('tenant_id', '=', this.tenantId)
          .where('id', '=', id)
          .forUpdate()
          .executeTakeFirst();
        if (run?.status !== 'running') {
          throw new DbError('invalid_value', 'evaluation result: the run is not running');
        }
        const h = result.hardware;
        const row = await db
          .insertInto('evaluation_run_results')
          .values({
            tenant_id: this.tenantId,
            evaluation_run_id: id,
            attempt: run.attempt,
            instructions_sha256: result.instructions_sha256,
            outcome: result.outcome,
            status: result.status,
            stop_reason: result.stop_reason,
            applied: result.applied,
            resolved: result.resolved,
            fail_to_pass_passed: result.fail_to_pass_passed,
            pass_to_pass_passed: result.pass_to_pass_passed,
            ci_passed: result.ci_passed,
            scope_breach: result.scope_breach,
            out_of_plan_files: result.out_of_plan_files,
            lint_findings: result.lint_findings,
            diff_files: result.diff_files,
            diff_lines_added: result.diff_lines_added,
            diff_lines_removed: result.diff_lines_removed,
            seconds: result.seconds,
            iterations: result.iterations,
            model_calls: result.model_calls,
            input_tokens: result.input_tokens,
            output_tokens: result.output_tokens,
            cached_input_tokens: result.cached_input_tokens,
            cost_usd: result.cost_usd,
            hw_cpu_model: h.cpu_model,
            hw_cpu_cores: h.cpu_cores,
            hw_memory_gb: h.memory_gb,
            hw_docker_version: h.docker_version,
            hw_gpu: h.gpu,
            hw_runner_instance: h.runner_instance,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await db
          .updateTable('evaluation_runs')
          .set({
            status: 'scored',
            finished_at: sql<Date>`now()`,
            updated_at: sql<Date>`now()`,
          })
          .where('tenant_id', '=', this.tenantId)
          .where('id', '=', id)
          .execute();
        return row;
      }),
    );
  }

  /** The results of one evaluation with the codes of their runs, in a fixed order. */
  async resultsForEvaluation(
    evaluationId: string,
  ): Promise<
    (EvaluationRunResultRow & { configuration_id: string; task_id: string; run_index: number })[]
  > {
    if (!isUuid(evaluationId)) return [];
    return this.run(
      this.db
        .selectFrom('evaluation_run_results as r')
        .innerJoin('evaluation_runs as er', (join) =>
          join
            .onRef('er.tenant_id', '=', 'r.tenant_id')
            .onRef('er.id', '=', 'r.evaluation_run_id')
            .on('er.tenant_id', '=', this.tenantId),
        )
        .selectAll('r')
        .select(['er.configuration_id', 'er.task_id', 'er.run_index'])
        .where('r.tenant_id', '=', this.tenantId)
        .where('er.evaluation_id', '=', evaluationId)
        .orderBy('er.configuration_id')
        .orderBy('er.task_id')
        .orderBy('er.run_index')
        .execute(),
    );
  }

  private async move(
    id: string,
    from: EvaluationRun['status'],
    set: Record<string, unknown>,
  ): Promise<boolean> {
    if (!isUuid(id)) return false;
    const result = await this.run(
      this.db
        .updateTable('evaluation_runs')
        .set({ ...(set as object), updated_at: sql<Date>`now()` })
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .where('status', '=', from)
        .executeTakeFirst(),
    );
    return Number(result.numUpdatedRows) === 1;
  }
}
