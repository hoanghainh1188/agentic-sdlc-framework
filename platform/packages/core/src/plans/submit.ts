// Submitting an intent's plan (task B09, D-08 B09 AC1–AC2, design/ADR-M40 §2.3, QUESTIONS #165,
// #168). The API calls `submitPlanFromGitHost`; it reads `.sdlc/plans/<intent code>.yaml` from
// the Git host, checks it, and stores its SHA-256 and coded fields; the text is dropped.
//
// - Who: a role in project config `access.plan_submit_roles` (default Person A; never `viewer`,
//   rule M24). No role on the project → `intent_not_found`; a read role only → `forbidden`. The
//   submitter is a producer of the plan: they never approve G3 (FR-11).
// - When: the intent is `draft` or waits at G1–G4. A plan submitted while the intent waits at G4
//   takes it back to G3 at the next step (`plan-check.ts`).
// - What: the plan is the file at the head of the project's default branch, like the spec
//   (ADR-M39 §2.1). The commit is optional; a given commit must hold the same file as the head.
// - Submitting the same file again changes nothing (the latest version is returned).
import { GitHostError, type ProjectRole } from '@sdlc/contracts';

import { CommandError } from '../commands/errors.js';
import type { Intent, Plan } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { loadEffectiveConfig } from '../registry/effective-config.js';
import type { SpecGitHost } from '../specs/link.js';
import { projectRepoRef } from '../workflow/g4-proposal.js';
import { PlanError } from './errors.js';
import { parsePlanFile, type ParsedPlan } from './parse.js';
import { readPlanFile } from './read.js';

export interface PlanAccess {
  /** Active roles of the user on the project. Empty: the intent is invisible to the user. */
  readonly roles: readonly ProjectRole[];
  readonly canRead: boolean;
  readonly canSubmit: boolean;
}

/** Who may read the intent's plans (`access.intent_read_roles`) and submit one. */
export async function planAccess(
  scope: TenantScope,
  projectId: string,
  userId: string,
): Promise<PlanAccess> {
  const roles = (await scope.roleBindings.listForUser(userId))
    .filter((binding) => binding.project_id === projectId)
    .map((binding) => binding.role);
  if (roles.length === 0) return { roles, canRead: false, canSubmit: false };
  const { config } = await loadEffectiveConfig(scope.projectConfigs, projectId);
  const canSubmit = roles.some((role) => config.access.plan_submit_roles.includes(role));
  const canRead =
    canSubmit ||
    roles.some(
      (role) =>
        config.access.intent_read_roles.includes(role) ||
        config.access.intent_create_roles.includes(role),
    );
  return { roles, canRead, canSubmit };
}

/** The intent states that take a plan: `draft`, or waiting at G1–G4 (QUESTIONS #168). */
export function planSubmittable(intent: Pick<Intent, 'status' | 'current_gate'>): boolean {
  if (intent.status === 'draft') return true;
  return (
    intent.status === 'in_gate' &&
    intent.current_gate !== null &&
    ['G1', 'G2', 'G3', 'G4'].includes(intent.current_gate)
  );
}

export interface SubmitPlanRequest {
  readonly intent: Intent;
  /** A commit of the repository; default the head of the default branch. */
  readonly commitSha?: string | null;
  /** The person who submits; holds a role in `access.plan_submit_roles`. */
  readonly actorId: string;
}

const COMMIT_SHA = /^[0-9a-f]{40}$/;

/** Reads the plan file, checks it against the default branch's head, and stores a new version. */
export async function submitPlanFromGitHost(
  scope: TenantScope,
  deps: SpecGitHost,
  request: SubmitPlanRequest,
): Promise<Plan> {
  const { intent } = request;
  const access = await planAccess(scope, intent.project_id, request.actorId);
  if (!access.canRead) {
    throw new CommandError('intent_not_found', `intent ${intent.code} not found`);
  }
  if (!access.canSubmit) throw new CommandError('forbidden', 'the caller may not submit a plan');
  const commit = request.commitSha ?? null;
  if (commit !== null && !COMMIT_SHA.test(commit)) {
    throw new PlanError('invalid_commit', 'commit must be a 40-hex commit SHA');
  }
  if (!planSubmittable(intent)) {
    throw new PlanError('submit_not_allowed', `${intent.code} does not take a plan now`);
  }
  const project = await scope.projects.getById(intent.project_id);
  const ref = project ? projectRepoRef(project) : undefined;
  if (!project || !ref) throw new PlanError('repository_invalid', 'repository name invalid');

  const read = await readOnDefaultBranch(deps, ref, project.default_branch, intent.code, commit);
  return scope.transaction(async (tx) => {
    const locked = await tx.intents.lockAndGet(intent.id);
    if (!locked || !planSubmittable(locked)) {
      throw new PlanError('submit_not_allowed', `${intent.code} does not take a plan now`);
    }
    // The role may have been withdrawn while the Git host was read.
    if (!(await planAccess(tx, intent.project_id, request.actorId)).canSubmit) {
      throw new CommandError('forbidden', 'the caller may not submit a plan');
    }
    const latest = await tx.plans.latest(intent.id);
    if (latest && latest.commit_sha !== null && latest.plan_sha256 === read.sha256) return latest;
    return tx.plans.submit(intent.id, {
      actorType: 'human',
      actorId: request.actorId,
      plannedFiles: read.plan.plannedFiles,
      planSha256: read.sha256,
      changeFlags: read.plan.changeFlags,
      file: { commitSha: commit ?? read.head, allowedTools: read.plan.allowedTools },
    });
  });
}

async function readOnDefaultBranch(
  deps: SpecGitHost,
  ref: Parameters<typeof readPlanFile>[1],
  branch: string,
  intentCode: string,
  commit: string | null,
): Promise<{ head: string; sha256: string; plan: ParsedPlan }> {
  try {
    const head = await deps.gitHost.getBranchHead(ref, branch);
    const atHead = await readPlanFile(deps.gitHost, ref, intentCode, head);
    if (atHead.kind === 'unreadable') {
      throw new PlanError('plan_invalid', 'plan cannot be read at head', atHead.cause);
    }
    const parsed = parsePlanFile(atHead.text, intentCode);
    if (!parsed.ok) {
      throw new PlanError('plan_invalid', 'plan refused', parsed.reason, undefined, parsed.field);
    }
    if (commit !== null && commit !== head) {
      const atCommit = await readPlanFile(deps.gitHost, ref, intentCode, commit);
      if (atCommit.kind === 'unreadable' || atCommit.sha256 !== atHead.sha256) {
        throw new PlanError('not_on_default_branch', 'the commit holds another plan');
      }
    }
    return { head, sha256: atHead.sha256, plan: parsed.plan };
  } catch (error) {
    if (error instanceof GitHostError) {
      throw new PlanError('git_host_unavailable', 'git host unavailable', undefined, error.code);
    }
    throw error;
  }
}
