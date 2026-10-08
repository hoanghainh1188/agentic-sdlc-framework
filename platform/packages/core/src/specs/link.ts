// Linking a spec to an intent (task B08, D-08 B08 AC1, D-02 FR-02, design/ADR-M39 §2.2,
// QUESTIONS #160, #162). The API calls `linkSpecFromGitHost`; it reads the file from the Git host,
// keeps its SHA-256 and drops the content (client data stays in the repository).
//
// - Who: a role in project config `access.spec_link_roles` (never `viewer`, rule M23). No role on
//   the project → `intent_not_found`; a read role only → `forbidden`.
// - When: the intent is `draft` or waits at G1–G4. A spec linked while the intent waits at G3 or
//   G4 takes it back to G2 at the next step (`spec-check.ts`).
// - What: the spec is the file at the head of the project's default branch (QUESTIONS #160). The
//   commit is optional; a given commit must hold the same content as the head
//   (`not_on_default_branch` otherwise), so the approved spec is the one the agent will read.
// - Linking the same path and content again changes nothing (the latest version is returned),
//   unless that version was linked before S01 and has no acceptance criteria count: then a new
//   version with a count is linked (QUESTIONS #290).
// - S01 (ADR-M61): the file's structure and acceptance criteria are counted with its hash
//   (`readSpec`); a spec without criteria is linked, and G2 waits on it (`spec_unclear`).
import { GitHostError, type GitHostAdapter, type ProjectRole } from '@sdlc/contracts';

import { CommandError } from '../commands/errors.js';
import type { SpecSourceTool } from '../db/vocabulary.js';
import type { Intent, SpecRef } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { loadEffectiveConfig } from '../registry/effective-config.js';
import { projectRepoRef } from '../workflow/g4-proposal.js';
import { SpecError } from './errors.js';
import { readSpec } from './read.js';
import type { SpecStructure } from './structure.js';
import { isSpecPath } from './rules.js';

/** What spec linking reads from the Git host (the API wires the GitHub adapter). */
export interface SpecGitHost {
  readonly gitHost: Pick<GitHostAdapter, 'getBranchHead' | 'getFileAtCommit'>;
}

export interface SpecAccess {
  /** Active roles of the user on the project. Empty: the intent is invisible to the user. */
  readonly roles: readonly ProjectRole[];
  readonly canRead: boolean;
  readonly canLink: boolean;
}

/** Who may read the intent's specs (`access.intent_read_roles`) and link one (`spec_link_roles`). */
export async function specAccess(
  scope: TenantScope,
  projectId: string,
  userId: string,
): Promise<SpecAccess> {
  const roles = (await scope.roleBindings.listForUser(userId))
    .filter((binding) => binding.project_id === projectId)
    .map((binding) => binding.role);
  if (roles.length === 0) return { roles, canRead: false, canLink: false };
  const { config } = await loadEffectiveConfig(scope.projectConfigs, projectId);
  const canLink = roles.some((role) => config.access.spec_link_roles.includes(role));
  const canRead =
    canLink ||
    roles.some(
      (role) =>
        config.access.intent_read_roles.includes(role) ||
        config.access.intent_create_roles.includes(role),
    );
  return { roles, canRead, canLink };
}

/** The intent states that take a spec: `draft`, or waiting at G1–G4. */
export function specLinkable(intent: Pick<Intent, 'status' | 'current_gate'>): boolean {
  if (intent.status === 'draft') return true;
  return (
    intent.status === 'in_gate' &&
    intent.current_gate !== null &&
    ['G1', 'G2', 'G3', 'G4'].includes(intent.current_gate)
  );
}

export interface LinkSpecRequest {
  readonly intent: Intent;
  readonly path: string;
  /** A commit of the repository; default the head of the default branch. */
  readonly commitSha?: string | null;
  readonly sourceTool?: SpecSourceTool | null;
  /** The person who links; holds a role in `access.spec_link_roles`. */
  readonly actorId: string;
}

const COMMIT_SHA = /^[0-9a-f]{40}$/;

/** Reads the file, checks it against the default branch's head, and links a new version. */
export async function linkSpecFromGitHost(
  scope: TenantScope,
  deps: SpecGitHost,
  request: LinkSpecRequest,
): Promise<SpecRef> {
  const { intent, path } = request;
  const access = await specAccess(scope, intent.project_id, request.actorId);
  if (!access.canRead) {
    throw new CommandError('intent_not_found', `intent ${intent.code} not found`);
  }
  if (!access.canLink) throw new CommandError('forbidden', 'the caller may not link a spec');
  if (!isSpecPath(path)) throw new SpecError('invalid_path', 'not a Markdown file path');
  const commit = request.commitSha ?? null;
  if (commit !== null && !COMMIT_SHA.test(commit)) {
    throw new SpecError('invalid_path', 'commit must be a 40-hex commit SHA');
  }
  if (!specLinkable(intent)) {
    throw new SpecError('link_not_allowed', `${intent.code} does not take a spec now`);
  }
  const project = await scope.projects.getById(intent.project_id);
  const ref = project ? projectRepoRef(project) : undefined;
  if (!project || !ref) throw new SpecError('repository_invalid', 'repository name invalid');

  const tool = request.sourceTool ?? null;
  const { head, sha256, structure } = await readOnDefaultBranch(
    deps,
    ref,
    project.default_branch,
    { path, commit },
    tool,
  );
  return scope.transaction(async (tx) => {
    const locked = await tx.intents.lockAndGet(intent.id);
    if (!locked || !specLinkable(locked)) {
      throw new SpecError('link_not_allowed', `${intent.code} does not take a spec now`);
    }
    // The role may have been withdrawn while the Git host was read.
    if (!(await specAccess(tx, intent.project_id, request.actorId)).canLink) {
      throw new CommandError('forbidden', 'the caller may not link a spec');
    }
    const latest = await tx.specRefs.latest(intent.id);
    if (
      latest?.path === path &&
      latest.content_sha256 === sha256 &&
      latest.acceptance_criteria !== null
    ) {
      return latest;
    }
    return tx.specRefs.link(intent.id, {
      actorType: 'human',
      actorId: request.actorId,
      path,
      commitSha: commit ?? head,
      contentSha256: sha256,
      sourceTool: tool,
      cause: 'linked',
      structure: structure.structure,
      acceptanceCriteria: structure.acceptanceCriteria,
    });
  });
}

async function readOnDefaultBranch(
  deps: SpecGitHost,
  ref: Parameters<typeof readSpec>[1],
  branch: string,
  at: { readonly path: string; readonly commit: string | null },
  tool: SpecSourceTool | null,
): Promise<{ head: string; sha256: string; structure: SpecStructure }> {
  try {
    const head = await deps.gitHost.getBranchHead(ref, branch);
    const atHead = await readSpec(deps.gitHost, ref, at.path, head, tool);
    if (atHead.kind === 'unreadable') {
      throw new SpecError('spec_unreadable', 'spec cannot be read at head', atHead.cause);
    }
    if (at.commit !== null && at.commit !== head) {
      const atCommit = await readSpec(deps.gitHost, ref, at.path, at.commit);
      if (atCommit.kind === 'unreadable') {
        throw new SpecError('spec_unreadable', 'spec cannot be read at commit', atCommit.cause);
      }
      if (atCommit.sha256 !== atHead.sha256) {
        throw new SpecError('not_on_default_branch', 'the commit holds another version');
      }
    }
    return {
      head,
      sha256: atHead.sha256,
      structure: {
        structure: atHead.structure,
        acceptanceCriteria: atHead.acceptanceCriteria,
      },
    };
  } catch (error) {
    if (error instanceof GitHostError) {
      throw new SpecError('git_host_unavailable', 'git host unavailable', undefined, error.code);
    }
    throw error;
  }
}
