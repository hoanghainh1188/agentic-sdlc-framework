// A project's own evaluation tasks for the authenticated caller (task L07, design/ADR-M85).
// - Read: a tenant admin, or anybody with a role on the project. No role → 404.
// - Draft, register, approve, reject: a role in `access.eval_roles` (core checks it); the reviewer
//   is never a producer of the intent.
// - The draft returns the card's fields for the CLI to write on the person's machine; the platform
//   stores nothing for it. Every value is a code, an ID, a commit, a path of the card or a hash.
import {
  CommandError,
  draftEvaluationTask,
  listEvaluationTasks,
  mayReadPlans,
  registerEvaluationTask,
  reviewEvaluationTask,
  type EvaluationTask,
  type EvaluationTaskGitHost,
  type Project,
} from '@sdlc/core';
import type { TaskCard } from '@sdlc/eval';
import type { z } from 'zod';

import type { Principal } from '../auth/principal.js';
import { ApiError } from '../errors/api-error.js';
import type {
  approveTaskSchema,
  draftTaskSchema,
  registerTaskSchema,
  rejectTaskSchema,
} from './schemas.js';

/** The card's fields as the API returns them (snake_case); the CLI writes the YAML. */
export function presentCard(card: TaskCard): Record<string, unknown> {
  return {
    id: card.id,
    intent: card.intent,
    base_commit: card.baseCommit,
    merge_commit: card.mergeCommit,
    spec: { path: card.spec.path, commit: card.spec.commit, sha256: card.spec.sha256 },
    hidden_tests: [...card.hiddenTests],
    planned_files: [...card.plannedFiles],
    fail_to_pass: [...card.failToPass],
    pass_to_pass: [...card.passToPass],
    ci: [...card.ci],
  };
}

export function presentTask(task: EvaluationTask, intentCode: string): Record<string, unknown> {
  return {
    id: task.id,
    task: task.task_id,
    intent: intentCode,
    card_path: task.card_path,
    card_commit: task.card_commit,
    card_sha256: task.card_sha256,
    base_commit: task.base_commit,
    merge_commit: task.merge_commit,
    status: task.status,
    check_code: task.check_code,
    created_at: task.created_at.toISOString(),
    updated_at: task.updated_at.toISOString(),
  };
}

export class EvaluationTasksService {
  constructor(private readonly deps: { readonly gitHost?: EvaluationTaskGitHost }) {}

  private taskDeps(): { gitHost: EvaluationTaskGitHost } {
    if (!this.deps.gitHost) throw new ApiError(503, 'git_host_unavailable');
    return { gitHost: this.deps.gitHost };
  }

  private async readableProject(p: Principal, slug: string): Promise<Project> {
    const project = await p.scope.projects.getBySlug(slug);
    if (!project || !(await mayReadPlans(p.scope, p.userId, project.id))) {
      throw new CommandError('project_not_found', `project ${slug} not found`);
    }
    return project;
  }

  private async present(p: Principal, task: EvaluationTask): Promise<Record<string, unknown>> {
    const intent = await p.scope.intents.getById(task.intent_id);
    return presentTask(task, intent?.code ?? '');
  }

  async list(p: Principal, slug: string): Promise<Record<string, unknown>> {
    const project = await this.readableProject(p, slug);
    const tasks = await listEvaluationTasks(p.scope, { userId: p.userId, projectId: project.id });
    const out: Record<string, unknown>[] = [];
    for (const task of tasks) out.push(await this.present(p, task));
    return { tasks: out };
  }

  async draft(
    p: Principal,
    slug: string,
    query: z.infer<typeof draftTaskSchema>,
  ): Promise<Record<string, unknown>> {
    const project = await this.readableProject(p, slug);
    const card = await draftEvaluationTask(p.scope, this.taskDeps(), {
      userId: p.userId,
      projectId: project.id,
      intentCode: query.intent,
      taskId: query.task,
    });
    return { card: presentCard(card) };
  }

  async register(
    p: Principal,
    slug: string,
    body: z.infer<typeof registerTaskSchema>,
  ): Promise<Record<string, unknown>> {
    const project = await this.readableProject(p, slug);
    const { task, outcome } = await registerEvaluationTask(p.scope, this.taskDeps(), {
      userId: p.userId,
      projectId: project.id,
      taskId: body.task,
    });
    return { outcome, task: await this.present(p, task) };
  }

  async review(
    p: Principal,
    id: string,
    body: z.infer<typeof approveTaskSchema> | z.infer<typeof rejectTaskSchema>,
    decision: 'approved' | 'rejected',
  ): Promise<Record<string, unknown>> {
    const found = await p.scope.evaluationTasks.getById(id);
    if (!found || !(await mayReadPlans(p.scope, p.userId, found.project_id))) {
      throw new ApiError(404, 'not_found');
    }
    const task = await reviewEvaluationTask(p.scope, this.taskDeps(), {
      userId: p.userId,
      id,
      cardSha256: body.card_sha256,
      decision,
      reason: 'reason' in body ? body.reason : null,
    });
    return { task: await this.present(p, task) };
  }
}
