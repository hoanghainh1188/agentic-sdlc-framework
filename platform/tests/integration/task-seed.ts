// Seeds a tenant for the evaluation task tests (task L07, ADR-M85): a merged intent (a pushed run
// and the `pr_merged` event G7 records), its linked spec, Person A (the creator), a reviewer, a
// commit author linked to a GitHub account and a viewer; and a fake Git host for the task reads.
import type { PlatformDatabase } from '../../packages/core/src/db/platform-database.js';
import {
  GitHostError,
  type CommitAuthors,
  type MergedChange,
} from '../../packages/contracts/src/index.js';
import type { EvaluationTaskGitHost } from '../../packages/core/src/evaluation/index.js';
import { seedRun, type SeededRun } from './cost-seed.js';

export const TASK_NOW = new Date('2026-10-20T08:00:00.000Z');
export const TASK_BASE = '1'.repeat(40);
export const TASK_MERGE = '2'.repeat(40);
export const TASK_HEAD = '3'.repeat(40);
export const TASK_SPEC = {
  path: 'docs/specs/tax.md',
  commit: '4'.repeat(40),
  sha256: '5'.repeat(64),
};
export const TASK_AUTHOR = { id: '4242', login: 'carol', type: 'user' as const };
export const TASK_FILES: MergedChange['files'] = [
  { path: 'apps/api/src/tax.ts', status: 'modified', previousPath: null },
  { path: 'apps/api/src/tax.spec.ts', status: 'added', previousPath: null },
];

export interface TaskWorld extends SeededRun {
  readonly reviewer: string;
  readonly author: string;
  readonly viewer: string;
}

/** What the fake Git host answers; tests change it between calls. */
export interface TaskGitState {
  files: Map<string, string>;
  change: MergedChange;
  authors: CommitAuthors;
}

export function taskGitState(): TaskGitState {
  return {
    files: new Map(),
    change: {
      mergeCommitSha: TASK_MERGE,
      mergeCommitParents: [TASK_BASE, '6'.repeat(40)],
      commitCount: 2,
      files: TASK_FILES,
    },
    authors: { accounts: [TASK_AUTHOR], withoutAccount: 0 },
  };
}

export function fakeTaskGitHost(state: TaskGitState): EvaluationTaskGitHost {
  return {
    getBranchHead: () => Promise.resolve(TASK_HEAD),
    getFileAtCommit: (_ref, path) => {
      const text = state.files.get(path);
      return text === undefined
        ? Promise.reject(new GitHostError('not_found'))
        : Promise.resolve(text);
    },
    getMergedChange: () => Promise.resolve(state.change),
    getCommitParents: () => Promise.resolve([TASK_BASE]),
    compareChangedFiles: (_ref, base, head) =>
      Promise.resolve(
        base === TASK_BASE && head === TASK_MERGE
          ? state.change.files.map((f) => f.path).sort()
          : ['other.ts'],
      ),
    getCommitAuthors: () => Promise.resolve(state.authors),
  };
}

export async function seedTaskWorld(
  db: PlatformDatabase,
  slug: string,
  merged = true,
): Promise<TaskWorld> {
  const seeded = await seedRun(db, { slug, models: ['m'], now: TASK_NOW });
  const { scope } = seeded;
  const person = async (name: string, role: 'person_b' | 'viewer') => {
    const user = await scope.users.create({ display_name: name, email: `${name}@example.com` });
    await scope.roleBindings.grant({ user_id: user.id, project_id: seeded.projectId, role });
    return user.id;
  };
  const reviewer = await person('rob', 'person_b');
  const author = await person('carol', 'person_b');
  const viewer = await person('vic', 'viewer');
  await scope.userIdentities.link({
    user_id: author,
    provider: 'github',
    external_id: TASK_AUTHOR.id,
    external_login: TASK_AUTHOR.login,
  });
  await scope.roleBindings.grant({
    user_id: seeded.personA,
    project_id: seeded.projectId,
    role: 'person_a',
  });
  await scope.specRefs.link(seeded.intentId, {
    path: TASK_SPEC.path,
    commitSha: TASK_SPEC.commit,
    contentSha256: TASK_SPEC.sha256,
    structure: 'spec_kit',
    acceptanceCriteria: 2,
    actorType: 'human',
    actorId: seeded.personA,
  });
  await scope.runEvents.append(seeded.runId, 'branch_pushed', {
    head_sha: '7'.repeat(40),
    parent_sha: TASK_BASE,
    diff_sha256: '8'.repeat(64),
    paths_sha256: '9'.repeat(64),
  });
  if (merged) {
    await scope.runEvents.append(seeded.runId, 'pr_merged', {
      pr_number: 12,
      head_sha: '7'.repeat(40),
      merge_commit_sha: TASK_MERGE,
    });
  }
  return { ...seeded, reviewer, author, viewer };
}
