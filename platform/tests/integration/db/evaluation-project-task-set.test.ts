// D-08 L07 PR 4c on PostgreSQL (design/ADR-M85 §2.7, §2.9, §2.10; QUESTIONS #490, #491):
// evaluations on a project's own task set.
// - a plan names the task set `project`: only approved tasks, at least one, and a data class not
//   below the highest data class of the tasks' intents; no version and no commit on the plan;
// - an evaluation of it reads the cards on the default branch when it starts: the commit and the
//   task IDs are its version; each run has its task's base commit; a removed card makes its task
//   `gone`, a changed card is left out;
// - the contract names the kind, the commit and the run's base commit;
// - the database keeps the kind, the commit and the run's base commit fixed.
import crypto from 'node:crypto';

import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';
import { GitHostError, type ModelRef, type RunContractSigner } from '@sdlc/contracts';
import { renderTaskCard, type TaskCard } from '@sdlc/eval';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DbError } from '../../../packages/core/src/db/errors.js';
import {
  createEvaluationPlan,
  draftEvaluationTask,
  EvaluationError,
  issueEvaluationContract,
  registerEvaluationTask,
  reviewEvaluationTask,
  startEvaluationPlan,
  type EvaluationPlanDeps,
  type PlanContentInput,
} from '../../../packages/core/src/evaluation/index.js';
import {
  fakeTaskGitHost,
  seedTaskWorld,
  taskGitState,
  TASK_BASE,
  TASK_HEAD,
  TASK_NOW,
  type TaskGitState,
  type TaskWorld,
} from '../task-seed.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

const CARD_PATH = '.sdlc/eval-tasks/tax-rule.yaml';
const MODELS: ModelRef[] = [{ model: 'gpt-oss-20b', providerType: 'self_hosted' }];

const signer: RunContractSigner = {
  sign: () =>
    Promise.resolve({
      signature: `vault:v1:${crypto.randomBytes(48).toString('base64')}`,
      keyVersion: 1,
    }),
};

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    if (error instanceof EvaluationError || error instanceof DbError) return error.code;
    throw error;
  }
}

interface World extends TaskWorld {
  readonly agentKey: string;
  readonly taskId: string;
}

describeDb("L07 PR 4c: evaluations on a project's task set on PostgreSQL", () => {
  let t: TestDatabase;
  let tenants = 0;
  let git: TaskGitState;

  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  });

  const deps = (): EvaluationPlanDeps => ({
    policyFactory: (config, list) => createSimplePolicyEngine({ config, models: list }),
    models: () => Promise.resolve(MODELS),
    taskSet: () => Promise.resolve(undefined),
    gitHost: fakeTaskGitHost(git),
    now: () => TASK_NOW,
  });

  /** A merged intent (`internal`) with its task `tax-rule` registered; approved unless told. */
  async function world(approved = true): Promise<World> {
    git = taskGitState();
    const w = await seedTaskWorld(t.app, `ptasks-${String(++tenants)}`);
    const { scope } = w;
    await scope.projectAiRecords.save(w.projectId, {
      aiAllowed: 'yes',
      allowedDataClasses: ['public', 'internal', 'client_confidential'],
      prodLogsAllowed: 'no',
      disclosureFormat: 'standard_note',
      confirmedAt: '2026-10-19',
      recordRef: 'https://docs.example.test/project/ai-record',
      updatedBy: w.personA,
      expectedVersion: 0,
      actorType: 'human',
      today: '2026-10-20',
    });
    const taskDeps = { gitHost: fakeTaskGitHost(git) };
    const card: TaskCard = {
      ...(await draftEvaluationTask(scope, taskDeps, {
        userId: w.personA,
        projectId: w.projectId,
        intentCode: w.intentCode,
        taskId: 'tax-rule',
      })),
      failToPass: ['pnpm test -- apps/api/src/tax.spec.ts'],
      passToPass: ['pnpm test'],
      ci: ['pnpm lint'],
    };
    git.files.set(CARD_PATH, renderTaskCard(card));
    const { task } = await registerEvaluationTask(scope, taskDeps, {
      userId: w.personA,
      projectId: w.projectId,
      taskId: 'tax-rule',
    });
    if (approved) {
      await scope.evaluationTasks.startCheck(task.id, task.card_sha256);
      await scope.evaluationTasks.recordCheck(task.id, task.card_sha256, { status: 'checked' });
      await reviewEvaluationTask(scope, taskDeps, {
        userId: w.reviewer,
        id: task.id,
        cardSha256: task.card_sha256,
        decision: 'approved',
        reason: null,
      });
    }
    const agent = await scope.agents.getById(w.agentId);
    return { ...w, agentKey: agent!.agent_key, taskId: task.id };
  }

  const content = (w: World, over: Partial<PlanContentInput> = {}): PlanContentInput => ({
    dataClass: 'internal',
    taskSetKind: 'project',
    taskSetVersion: null,
    taskIds: null,
    runsPerTask: 2,
    budgetPerRunUsd: '2',
    monthlyCapUsd: '5',
    trigger: 'once',
    configurations: [{ id: 'oss', agentKey: w.agentKey, maxIterations: 30, maxDurationMin: 20 }],
    ...over,
  });

  const create = (w: World, over: Partial<PlanContentInput> = {}) =>
    createEvaluationPlan(w.scope, deps(), {
      projectId: w.projectId,
      code: 'project-tasks',
      content: content(w, over),
      userId: w.personA,
    });

  const start = (w: World, planId: string) =>
    startEvaluationPlan(w.scope, deps(), {
      planId,
      actor: { type: 'human', userId: w.personA },
    });

  describe('a plan on the project task set', () => {
    it('is stored with the kind and no version or commit', async () => {
      const w = await world();
      const plan = await create(w);
      const version = await w.scope.evaluationPlans.getVersion(plan.id, 1);
      expect(version).toMatchObject({
        taskSetKind: 'project',
        taskSetVersion: null,
        taskIds: null,
      });
    });

    it('refuses a task that is not approved, an empty set, a low data class, a version', async () => {
      const w = await world();
      expect(await errorCode(create(w, { taskIds: ['other-task'] }))).toBe('task_not_found');
      // The intent is `internal`: a `public` evaluation would send its code as public data.
      expect(await errorCode(create(w, { dataClass: 'public' }))).toBe('data_class_below_tasks');
      expect(await errorCode(create(w, { taskSetVersion: 1 }))).toBe('invalid_input');
      expect(await errorCode(create(w, { dataClass: 'client_confidential' }))).toBeUndefined();

      const unapproved = await world(false);
      expect(await errorCode(create(unapproved))).toBe('task_set_empty');
    });
  });

  describe('an evaluation of it', () => {
    it("reads the cards at the branch's head: the commit and task IDs, each run's base", async () => {
      const w = await world();
      const plan = await create(w);
      const evaluation = await start(w, plan.id);
      expect(evaluation).toMatchObject({
        task_set_kind: 'project',
        task_set_version: null,
        task_set_commit: TASK_HEAD,
        base_sha: null,
        task_ids: ['tax-rule'],
      });
      const runs = await w.scope.evaluationRuns.listForEvaluation(evaluation.id);
      expect(runs).toHaveLength(2);
      for (const run of runs) expect(run.base_sha).toBe(TASK_BASE);

      const [started] = await w.scope.audit.listForEntity(evaluation.id, ['evaluation.started']);
      expect(started?.payload).toMatchObject({
        task_set_kind: 'project',
        task_set_commit: TASK_HEAD,
      });
      expect(started?.payload).not.toHaveProperty('task_set_version');

      const issued = await issueEvaluationContract(
        w.scope,
        { evaluationRunId: runs[0]!.id, egressAllowlist: ['litellm:4000'] },
        { signer, now: () => TASK_NOW },
      );
      expect(issued.envelope.contract).toMatchObject({
        schema_version: 2,
        repo: 'org/pilot-order-inventory',
        base_sha: TASK_BASE,
        task_id: 'tax-rule',
        task_set_kind: 'project',
        task_set_version: null,
        task_set_commit: TASK_HEAD,
      });
      // No path of the card, the spec or the tests in the contract.
      expect(JSON.stringify(issued.envelope.contract)).not.toMatch(/\.yaml|\.ts|\.md/);
    });

    it('leaves out a changed card and makes a removed card gone', async () => {
      const changed = await world();
      const plan = await create(changed);
      git.files.set(CARD_PATH, `${git.files.get(CARD_PATH)!}# changed\n`);
      expect(await errorCode(start(changed, plan.id))).toBe('task_set_empty');
      expect((await changed.scope.evaluationTasks.getById(changed.taskId))?.status).toBe(
        'approved',
      );

      const removed = await world();
      const other = await create(removed);
      git.files.delete(CARD_PATH);
      expect(await errorCode(start(removed, other.id))).toBe('task_set_empty');
      expect((await removed.scope.evaluationTasks.getById(removed.taskId))?.status).toBe('gone');
    });

    it('refuses when the Git host cannot be read', async () => {
      const w = await world();
      const plan = await create(w);
      const failing: EvaluationPlanDeps = {
        ...deps(),
        gitHost: {
          getBranchHead: () => Promise.reject(new GitHostError('network_error')),
          getFileAtCommit: () => Promise.reject(new Error('not reached')),
        },
      };
      expect(
        await errorCode(
          startEvaluationPlan(w.scope, failing, {
            planId: plan.id,
            actor: { type: 'human', userId: w.personA },
          }),
        ),
      ).toBe('git_host_unavailable');
    });
  });

  describe('the database', () => {
    it('keeps the kind, the commit and the base commits consistent and fixed', async () => {
      const w = await world();
      const evaluation = await start(w, (await create(w)).id);
      const [run] = await w.scope.evaluationRuns.listForEvaluation(evaluation.id);
      // A project set has a commit and no version; a numbered set the other way round.
      await expect(
        sql`UPDATE evaluations SET task_set_version = 1 WHERE id = ${evaluation.id}`.execute(
          t.owner,
        ),
      ).rejects.toMatchObject({ code: 'SDA21' });
      await expect(
        sql`UPDATE evaluations SET task_set_commit = ${'d'.repeat(40)} WHERE id = ${evaluation.id}`.execute(
          t.owner,
        ),
      ).rejects.toMatchObject({ code: 'SDA21' });
      await expect(
        sql`UPDATE evaluation_runs SET base_sha = ${'d'.repeat(40)} WHERE id = ${run!.id}`.execute(
          t.owner,
        ),
      ).rejects.toMatchObject({ code: 'SDA22' });
      await expect(
        sql`INSERT INTO evaluations (tenant_id, project_id, code, data_class, task_set_kind,
              task_set_version, task_set_commit, config_name, task_ids, configuration_ids,
              runs_per_task, budget_usd)
            VALUES (${w.scope.tenantId}, ${w.projectId}, 'EVAL-2026-9999', 'internal', 'project',
              1, ${'d'.repeat(40)}, 'x', ARRAY['tax-rule'], ARRAY['oss'], 1, 1)`.execute(t.owner),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });
});
