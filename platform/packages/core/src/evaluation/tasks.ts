// A project's own evaluation tasks (task L07, design/ADR-M85 §2.2–§2.8).
//
// - `draftEvaluationTask` reads the facts of a merged intent from the Git host and drafts a task
//   card (`@sdlc/eval` `draftTaskCard`). Nothing is stored: the card goes back to the caller, who
//   writes it on the person's machine and commits it through a pull request.
// - `registerEvaluationTask` reads a card from the project's default branch, checks it against the
//   intent (merged, same merge commit, a spec the intent linked) and stores the reference: path,
//   commit, SHA-256. The card's content is never stored.
// - `reviewEvaluationTask` approves or rejects a checked task. The reviewer has a role in
//   `access.eval_roles` and is never a producer of the intent (R029): its creator, the people who
//   started its runs or submitted its plans, the platform users among the commit authors.
// - A Git host that cannot be read refuses (`git_host_unavailable`); it never passes a check.
import { createHash } from 'node:crypto';

import { GitHostError, type GitHostAdapter } from '@sdlc/contracts';
import {
  draftTaskCard,
  parseTaskCard,
  TaskError,
  taskCardPath,
  type CommitLookup,
  type TaskCard,
} from '@sdlc/eval';

import { userOfAccount } from '../commands/git-event-handler.js';
import { DbError } from '../db/errors.js';
import type { RegisterOutcome } from '../db/repositories/evaluation-tasks.js';
import type { EvaluationTask, Intent, Project } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import type { EvaluationTaskRejectReason, GitProvider } from '../db/vocabulary.js';
import { loadEffectiveConfig } from '../registry/effective-config.js';
import { projectRepoRef } from '../workflow/g4-proposal.js';
import { g7Producers } from '../workflow/g7-facts.js';
import { gatherG8Merge } from '../workflow/g8-facts.js';
import { EvaluationError } from './errors.js';
import { assertEvalRole, mayReadPlans } from './plans.js';

const TASK_ID = /^[a-z][a-z0-9-]{1,47}$/;

/** The Git host calls of a project's tasks: reads only. */
export type EvaluationTaskGitHost = Pick<
  GitHostAdapter,
  | 'getBranchHead'
  | 'getFileAtCommit'
  | 'getMergedChange'
  | 'getCommitParents'
  | 'compareChangedFiles'
  | 'getCommitAuthors'
>;

export interface EvaluationTaskDeps {
  readonly gitHost: EvaluationTaskGitHost;
}

/** Runs a Git host read; any Git host error refuses with `git_host_unavailable`. */
async function read<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof GitHostError) {
      throw new EvaluationError('git_host_unavailable', 'the Git host could not be read');
    }
    throw error;
  }
}

async function projectOf(scope: TenantScope, projectId: string): Promise<Project> {
  const project = await scope.projects.getById(projectId);
  if (!project) throw new EvaluationError('project_not_found', 'no such project');
  return project;
}

function repoOf(project: Project) {
  const ref = projectRepoRef(project);
  if (!ref) throw new EvaluationError('git_host_unavailable', 'the project has no repository');
  return ref;
}

/** The merged intent of the project, with its pull request number and merge commit. */
async function mergedIntent(
  scope: TenantScope,
  project: Project,
  intent: Intent | undefined,
): Promise<{ intent: Intent; prNumber: number; mergeCommitSha: string | null }> {
  if (!intent || intent.project_id !== project.id) {
    throw new EvaluationError('intent_not_found', 'no such intent in the project');
  }
  if (intent.data_class === 'prohibited') {
    throw new EvaluationError('data_class_prohibited', 'prohibited data is never evaluated');
  }
  const merge = await gatherG8Merge(scope, intent);
  if (!merge) throw new EvaluationError('intent_not_merged', 'the intent has no merged change');
  return { intent, prNumber: merge.prNumber, mergeCommitSha: merge.mergeCommitSha };
}

export interface DraftEvaluationTaskInput {
  readonly userId: string;
  readonly projectId: string;
  readonly intentCode: string;
  readonly taskId: string;
}

/**
 * Drafts a task card from a merged intent (ADR-M85 §2.2 steps 1–2, AC4). Refused without a test
 * file (`no_tests`), without other files (`no_planned_files`), with an unclear base
 * (`base_unclear`), with too many files or a path a card cannot hold. Stores nothing.
 */
export async function draftEvaluationTask(
  scope: TenantScope,
  deps: EvaluationTaskDeps,
  input: DraftEvaluationTaskInput,
): Promise<TaskCard> {
  if (!TASK_ID.test(input.taskId)) throw new EvaluationError('invalid_input', 'task ID');
  await assertEvalRole(scope, input.userId, input.projectId);
  const project = await projectOf(scope, input.projectId);
  const ref = repoOf(project);
  const { intent, prNumber, mergeCommitSha } = await mergedIntent(
    scope,
    project,
    await scope.intents.getByCode(input.intentCode),
  );
  const spec = await scope.specRefs.latest(intent.id);
  if (!spec) throw new EvaluationError('spec_missing', 'the intent has no linked spec');
  const { config } = await loadEffectiveConfig(scope.projectConfigs, project.id);
  const change = await read(() => deps.gitHost.getMergedChange(ref, prNumber));
  if (mergeCommitSha !== null && change.mergeCommitSha !== mergeCommitSha) {
    throw new EvaluationError('base_unclear', 'the merge commit is not the one G7 recorded');
  }
  const lookup: CommitLookup = {
    getCommitParents: (sha) => read(() => deps.gitHost.getCommitParents(ref, sha)),
    compareChangedFiles: (base, head) =>
      read(() => deps.gitHost.compareChangedFiles(ref, base, head)),
  };
  const result = await draftTaskCard(
    {
      id: input.taskId,
      intent: intent.code,
      change,
      spec: { path: spec.path, commit: spec.commit_sha, sha256: spec.content_sha256 },
      testGlobs: config.evaluation.tasks.test_globs,
      commands: config.evaluation.tasks.commands,
    },
    lookup,
  );
  if (!result.ok) {
    throw new EvaluationError(
      result.code === 'unsafe_path' ? 'card_invalid' : result.code,
      'the change cannot make a task',
    );
  }
  return result.card;
}

export interface RegisterEvaluationTaskInput {
  readonly userId: string | null;
  readonly projectId: string;
  readonly taskId: string;
}

/**
 * Registers a card from the default branch (ADR-M85 §2.2 step 5). The card must be valid, name a
 * merged intent of the project with the same merge commit, and a spec the intent linked (path and
 * SHA-256). Only the reference is stored. `userId` null: the operator.
 */
export async function registerEvaluationTask(
  scope: TenantScope,
  deps: EvaluationTaskDeps,
  input: RegisterEvaluationTaskInput,
): Promise<{ task: EvaluationTask; outcome: RegisterOutcome }> {
  if (!TASK_ID.test(input.taskId)) throw new EvaluationError('invalid_input', 'task ID');
  if (input.userId !== null) await assertEvalRole(scope, input.userId, input.projectId);
  const project = await projectOf(scope, input.projectId);
  const ref = repoOf(project);
  const path = taskCardPath(input.taskId);
  const commit = await read(() => deps.gitHost.getBranchHead(ref, project.default_branch));
  let text: string;
  try {
    text = await deps.gitHost.getFileAtCommit(ref, path, commit);
  } catch (error) {
    if (error instanceof GitHostError && error.code === 'not_found') {
      throw new EvaluationError('card_not_found', 'the card is not on the default branch');
    }
    if (error instanceof GitHostError) {
      throw new EvaluationError('git_host_unavailable', 'the Git host could not be read');
    }
    throw error;
  }
  let card: TaskCard;
  try {
    card = parseTaskCard(text, path);
  } catch (error) {
    if (error instanceof TaskError) throw new EvaluationError('card_invalid', 'card format');
    throw error;
  }
  const { intent, prNumber, mergeCommitSha } = await mergedIntent(
    scope,
    project,
    await scope.intents.getByCode(card.intent),
  );
  const merged =
    mergeCommitSha ??
    (await read(() => deps.gitHost.getMergedChange(ref, prNumber))).mergeCommitSha;
  if (card.mergeCommit !== merged) {
    throw new EvaluationError('card_invalid', 'the card names another merge commit');
  }
  const specs = await scope.specRefs.list(intent.id);
  if (!specs.some((s) => s.path === card.spec.path && s.content_sha256 === card.spec.sha256)) {
    throw new EvaluationError('card_invalid', 'the card names a spec the intent did not link');
  }
  try {
    return await scope.evaluationTasks.register({
      projectId: project.id,
      taskId: card.id,
      intentId: intent.id,
      cardCommit: commit,
      cardSha256: createHash('sha256').update(text, 'utf8').digest('hex'),
      baseCommit: card.baseCommit,
      mergeCommit: card.mergeCommit,
      registeredBy: input.userId,
    });
  } catch (error) {
    if (error instanceof DbError && error.code === 'conflict') {
      throw new EvaluationError('task_id_taken', 'the task ID belongs to another intent');
    }
    if (error instanceof DbError && error.code === 'immutable') {
      throw new EvaluationError('task_gone', 'the task is gone');
    }
    throw error;
  }
}

export interface ReviewEvaluationTaskInput {
  readonly userId: string;
  /** The task's platform ID (`evaluation_tasks.id`). */
  readonly id: string;
  /** The card the reviewer saw. */
  readonly cardSha256: string;
  readonly decision: 'approved' | 'rejected';
  readonly reason: EvaluationTaskRejectReason | null;
}

/** The platform users among the pull request's commit authors (numeric account IDs). */
async function authorUsers(
  scope: TenantScope,
  deps: EvaluationTaskDeps,
  project: Project,
  prNumber: number,
): Promise<string[]> {
  const provider: GitProvider = project.git_provider;
  const authors = await read(() => deps.gitHost.getCommitAuthors(repoOf(project), prNumber));
  const users: string[] = [];
  for (const account of authors.accounts) {
    if (account.type !== 'user') continue;
    const user = await userOfAccount(scope, provider, account.id);
    if (user !== undefined) users.push(user);
  }
  return users;
}

/**
 * Approves or rejects a checked task (ADR-M85 §2.6, AC1). The reviewer has a role in
 * `access.eval_roles` and is not a producer of the intent; the decision is bound to the card's
 * SHA-256, so a changed card needs a new check and a new review.
 */
export async function reviewEvaluationTask(
  scope: TenantScope,
  deps: EvaluationTaskDeps,
  input: ReviewEvaluationTaskInput,
): Promise<EvaluationTask> {
  const task = await scope.evaluationTasks.getById(input.id);
  if (!task) throw new EvaluationError('task_not_found', 'no such task');
  await assertEvalRole(scope, input.userId, task.project_id);
  const project = await projectOf(scope, task.project_id);
  const intent = await scope.intents.getById(task.intent_id);
  if (!intent) throw new EvaluationError('intent_not_found', 'the task has no intent');
  const merge = await gatherG8Merge(scope, intent);
  if (!merge) throw new EvaluationError('intent_not_merged', 'the intent has no merged change');
  const producers = await g7Producers(
    scope,
    intent,
    await authorUsers(scope, deps, project, merge.prNumber),
  );
  if (producers.includes(input.userId)) {
    throw new EvaluationError('producer_cannot_review', 'a producer never reviews the task');
  }
  if (task.card_sha256 !== input.cardSha256) {
    throw new EvaluationError('task_changed', 'the card changed since it was read');
  }
  if (task.status !== 'checked') {
    throw new EvaluationError('task_not_checked', 'only a checked task is reviewed');
  }
  try {
    return await scope.evaluationTasks.decide({
      taskId: task.id,
      cardSha256: input.cardSha256,
      decision: input.decision,
      reason: input.reason,
      decidedBy: input.userId,
    });
  } catch (error) {
    if (error instanceof DbError && error.code === 'version_conflict') {
      throw new EvaluationError('task_changed', 'the task changed since it was read');
    }
    throw error;
  }
}

/** The tasks of a project, for anyone with a role on it (or a tenant admin). */
export async function listEvaluationTasks(
  scope: TenantScope,
  input: { readonly userId: string; readonly projectId: string },
): Promise<EvaluationTask[]> {
  if (!(await mayReadPlans(scope, input.userId, input.projectId))) {
    throw new EvaluationError('project_not_found', 'no role on the project');
  }
  return scope.evaluationTasks.listForProject(input.projectId);
}
