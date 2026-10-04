// Projects (task B13 AC2, ADR-M37 §2.3). Tenant admins create, change and archive projects. The
// slug and the Git host never change. Archiving only sets the status: purging the project's
// evidence and client data is E05 (FR-44).
import { DbError } from '../db/errors.js';
import type { ProjectUpdate } from '../db/repositories/projects.js';
import type { Project } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { assertTenantAdmin, auditActor, type AdminActor } from './actor.js';
import { AdminError } from './errors.js';
import {
  checkBranch,
  checkName,
  checkPattern,
  PROJECT_SLUG_PATTERN,
  REPO_FULL_NAME_PATTERN,
} from './validation.js';

/** Git hosts a project can use now. GitLab comes with its adapter (D-02 §4.2, MVP+1). */
export const SUPPORTED_GIT_PROVIDERS = ['github'] as const;

export interface NewProject {
  readonly slug: string;
  readonly name: string;
  readonly repoFullName: string;
  readonly defaultBranch?: string;
  readonly gitProvider?: (typeof SUPPORTED_GIT_PROVIDERS)[number];
}

export async function createProject(
  scope: TenantScope,
  actor: AdminActor,
  input: NewProject,
): Promise<Project> {
  const values = {
    slug: checkPattern('slug', input.slug, PROJECT_SLUG_PATTERN),
    name: checkName('name', input.name),
    repo_full_name: checkPattern('repo_full_name', input.repoFullName, REPO_FULL_NAME_PATTERN),
    default_branch: checkBranch(input.defaultBranch ?? 'main'),
    git_provider: input.gitProvider ?? 'github',
  };
  if (!(SUPPORTED_GIT_PROVIDERS as readonly string[]).includes(values.git_provider)) {
    throw new AdminError('invalid_value', 'unsupported Git host', { field: 'git_provider' });
  }
  return scope.transaction(async (tx) => {
    await assertTenantAdmin(tx, actor);
    const project = await tx.projects.create(values).catch(alreadyExists);
    await tx.audit.append({
      action: 'project.created',
      ...auditActor(actor),
      entityId: project.id,
      payload: { git_provider: project.git_provider },
    });
    return project;
  });
}

export interface ProjectChanges {
  readonly name?: string;
  readonly repoFullName?: string;
  readonly defaultBranch?: string;
}

export async function updateProject(
  scope: TenantScope,
  actor: AdminActor,
  slug: string,
  changes: ProjectChanges,
): Promise<Project> {
  const update: { -readonly [K in keyof ProjectUpdate]: ProjectUpdate[K] } = {};
  if (changes.name !== undefined) update.name = checkName('name', changes.name);
  if (changes.repoFullName !== undefined) {
    update.repo_full_name = checkPattern(
      'repo_full_name',
      changes.repoFullName,
      REPO_FULL_NAME_PATTERN,
    );
  }
  if (changes.defaultBranch !== undefined) {
    update.default_branch = checkBranch(changes.defaultBranch);
  }
  if (Object.keys(update).length === 0) {
    throw new AdminError('invalid_value', 'nothing to change', { field: 'body' });
  }
  return scope.transaction(async (tx) => {
    await assertTenantAdmin(tx, actor);
    const project = await activeProject(tx, slug);
    const updated = await tx.projects.update(project.id, update);
    if (!updated) throw new AdminError('project_not_found', `project ${slug} not found`);
    await tx.audit.append({
      action: 'project.updated',
      ...auditActor(actor),
      entityId: updated.id,
      payload: {},
    });
    return updated;
  });
}

/**
 * Archives an active project. Idempotent refusal: an archived project gives `project_archived`.
 * A project with open intents is refused (`project_has_open_intents`, E05). The retention loop
 * purges its evidence files after the archive grace period (FR-44, ADR-M51); there is no
 * un-archive in the MVP.
 */
export async function archiveProject(
  scope: TenantScope,
  actor: AdminActor,
  slug: string,
): Promise<Project> {
  return scope.transaction(async (tx) => {
    await assertTenantAdmin(tx, actor);
    const project = await activeProject(tx, slug);
    // E05 (QUESTIONS #237): an archive purges the project's evidence after the grace period;
    // its intents are finished (done, rejected, cancelled, blocked) first.
    if (await tx.intents.hasOpenInProject(project.id)) {
      throw new AdminError('project_has_open_intents', `project ${slug} has open intents`);
    }
    const archived = await tx.projects.setStatus(project.id, 'archived');
    if (!archived) throw new AdminError('project_not_found', `project ${slug} not found`);
    await tx.audit.append({
      action: 'project.archived',
      ...auditActor(actor),
      entityId: archived.id,
      payload: {},
    });
    return archived;
  });
}

export async function listProjects(scope: TenantScope, actor: AdminActor): Promise<Project[]> {
  await assertTenantAdmin(scope, actor);
  return scope.projects.list();
}

export async function showProject(
  scope: TenantScope,
  actor: AdminActor,
  slug: string,
): Promise<Project> {
  await assertTenantAdmin(scope, actor);
  const project = await scope.projects.getBySlug(slug);
  if (!project) throw new AdminError('project_not_found', `project ${slug} not found`);
  return project;
}

/** The project by slug; `project_archived` when it is archived. */
export async function activeProject(scope: TenantScope, slug: string): Promise<Project> {
  const project = await scope.projects.getBySlug(slug);
  if (!project) throw new AdminError('project_not_found', `project ${slug} not found`);
  if (project.status !== 'active') throw new AdminError('project_archived', 'project archived');
  return project;
}

/** Maps a unique violation to `already_exists`. */
export function alreadyExists(error: unknown): never {
  throw error instanceof DbError && error.code === 'conflict'
    ? new AdminError('already_exists', 'the value is already taken')
    : error;
}
