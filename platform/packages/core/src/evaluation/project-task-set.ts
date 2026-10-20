// A project's own task set (task L07, design/ADR-M85 §2.7, §2.9, §2.10; QUESTIONS #490, #491).
//
// - The task set of a project is its `approved` tasks. A plan may name some of them.
// - `checkProjectTaskSet` (a plan is saved): the named tasks are approved, at least one task is,
//   and the plan's data class is not below the highest data class of the tasks' intents. No Git
//   read.
// - `readProjectTaskSet` (an evaluation starts): reads the default branch's head, then each card at
//   that commit. A removed card makes its task `gone`; a card whose SHA-256 is not the approved one
//   is left out (a person registers it again). The version of the set is the commit with the task
//   IDs (§2.9); each task gives its base commit to its runs.
// A Git host that cannot be read refuses (`git_host_unavailable`): nothing is guessed.
import { createHash } from 'node:crypto';

import { DATA_CLASSES, GitHostError, type DataClass, type GitHostAdapter } from '@sdlc/contracts';

import type { EvaluationTask, Project } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { projectRepoRef } from '../workflow/g4-proposal.js';
import { EvaluationError } from './errors.js';

export interface ProjectTaskSet {
  /** The default branch's commit the cards were read from. */
  readonly commit: string;
  readonly taskIds: readonly string[];
  /** The base commit of each task, by task ID. */
  readonly baseShas: Readonly<Record<string, string>>;
}

const rank = (dataClass: DataClass): number => DATA_CLASSES.indexOf(dataClass);

/** The approved tasks of a project; with `taskIds`, only those (each must be approved). */
async function approvedTasks(
  scope: TenantScope,
  projectId: string,
  taskIds: readonly string[] | null,
): Promise<EvaluationTask[]> {
  const approved = (await scope.evaluationTasks.listForProject(projectId)).filter(
    (task) => task.status === 'approved',
  );
  if (taskIds === null) return approved;
  const byId = new Map(approved.map((task) => [task.task_id, task]));
  return taskIds.map((id) => {
    const task = byId.get(id);
    if (!task) throw new EvaluationError('task_not_found', 'a task is not approved');
    return task;
  });
}

/** Refuses a data class below the highest data class of the tasks' intents (ADR-M85 §2.7). */
async function assertDataClassCovers(
  scope: TenantScope,
  dataClass: DataClass,
  tasks: readonly EvaluationTask[],
): Promise<void> {
  for (const intentId of new Set(tasks.map((task) => task.intent_id))) {
    const intent = await scope.intents.getById(intentId);
    if (!intent) throw new EvaluationError('intent_not_found', 'the intent of a task is gone');
    if (rank(intent.data_class) > rank(dataClass)) {
      throw new EvaluationError('data_class_below_tasks', 'the data class is below a task');
    }
  }
}

/** Checks a plan's project task set when the plan is saved: no Git read. */
export async function checkProjectTaskSet(
  scope: TenantScope,
  input: {
    readonly projectId: string;
    readonly dataClass: DataClass;
    readonly taskIds: readonly string[] | null;
  },
): Promise<void> {
  const tasks = await approvedTasks(scope, input.projectId, input.taskIds);
  if (tasks.length === 0) throw new EvaluationError('task_set_empty', 'no approved task');
  await assertDataClassCovers(scope, input.dataClass, tasks);
}

/**
 * Reads the project's task set for an evaluation that starts now. A task the plan names that is no
 * longer approved is left out, like a changed card; an empty set refuses (`task_set_empty`).
 */
export async function readProjectTaskSet(
  scope: TenantScope,
  gitHost: Pick<GitHostAdapter, 'getBranchHead' | 'getFileAtCommit'>,
  input: {
    readonly project: Project;
    readonly dataClass: DataClass;
    readonly taskIds: readonly string[] | null;
  },
): Promise<ProjectTaskSet> {
  const { project } = input;
  const ref = projectRepoRef(project);
  if (!ref) throw new EvaluationError('git_host_unavailable', 'the project has no repository');
  const wanted = input.taskIds === null ? null : new Set(input.taskIds);
  const candidates = (await approvedTasks(scope, project.id, null)).filter(
    (task) => wanted === null || wanted.has(task.task_id),
  );
  const used: EvaluationTask[] = [];
  let commit: string;
  try {
    commit = await gitHost.getBranchHead(ref, project.default_branch);
    for (const task of candidates) {
      let text: string;
      try {
        text = await gitHost.getFileAtCommit(ref, task.card_path, commit);
      } catch (error) {
        if (!(error instanceof GitHostError && error.code === 'not_found')) throw error;
        await scope.evaluationTasks.markGone(task.id);
        continue;
      }
      if (createHash('sha256').update(text, 'utf8').digest('hex') === task.card_sha256) {
        used.push(task);
      }
    }
  } catch (error) {
    if (error instanceof GitHostError) {
      throw new EvaluationError('git_host_unavailable', 'the Git host could not be read');
    }
    throw error;
  }
  if (used.length === 0) throw new EvaluationError('task_set_empty', 'no approved task to run');
  await assertDataClassCovers(scope, input.dataClass, used);
  return {
    commit,
    taskIds: used.map((task) => task.task_id),
    baseShas: Object.fromEntries(used.map((task) => [task.task_id, task.base_commit])),
  };
}
