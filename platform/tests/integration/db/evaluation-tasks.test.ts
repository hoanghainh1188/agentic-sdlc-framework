// D-08 L07 PR 3a on PostgreSQL (design/ADR-M85 §2.2–§2.8, QUESTIONS #485–#487): a project's own
// evaluation tasks.
// - AC4: a merged fixture intent gives a draft card; a pull request without a test is refused;
// - AC1: a card on the default branch is registered (reference only); a reviewer with a role in
//   `access.eval_roles` who is not a producer approves or rejects a checked task, bound to the
//   card's SHA-256; a producer (creator, commit author), a viewer and another tenant are refused;
// - AC2: tables hold codes, commits and hashes only; another tenant never sees a task;
// - the decisions table is append-only; a gone task is final (SDA24).
import { createHash } from 'node:crypto';

import {
  GitHostError,
  type CommitAuthors,
  type MergedChange,
} from '../../../packages/contracts/src/index.js';
import { renderTaskCard, type TaskCard } from '@sdlc/eval';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DbError } from '../../../packages/core/src/db/errors.js';
import {
  draftEvaluationTask,
  EvaluationError,
  listEvaluationTasks,
  registerEvaluationTask,
  reviewEvaluationTask,
  type EvaluationTaskDeps,
} from '../../../packages/core/src/evaluation/index.js';
import { seedRun, type SeededRun } from '../cost-seed.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

const NOW = new Date('2026-10-20T08:00:00.000Z');
const BASE = '1'.repeat(40);
const MERGE = '2'.repeat(40);
const HEAD = '3'.repeat(40);
const SPEC = { path: 'docs/specs/tax.md', commit: '4'.repeat(40), sha256: '5'.repeat(64) };
const AUTHOR = { id: '4242', login: 'carol', type: 'user' as const };

const FILES: MergedChange['files'] = [
  { path: 'apps/api/src/tax.ts', status: 'modified', previousPath: null },
  { path: 'apps/api/src/tax.spec.ts', status: 'added', previousPath: null },
];

interface World extends SeededRun {
  readonly reviewer: string;
  readonly author: string;
  readonly viewer: string;
}

async function code(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    if (error instanceof EvaluationError || error instanceof DbError) return error.code;
    throw error;
  }
}

describeDb('L07 PR 3a: a project’s own evaluation tasks on PostgreSQL', () => {
  let t: TestDatabase;
  let tenants = 0;
  let files: Map<string, string>;
  let change: MergedChange;
  let authors: CommitAuthors;

  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  });

  const deps = (): EvaluationTaskDeps => ({
    gitHost: {
      getBranchHead: () => Promise.resolve(HEAD),
      getFileAtCommit: (_ref, path) => {
        const text = files.get(path);
        return text === undefined
          ? Promise.reject(new GitHostError('not_found'))
          : Promise.resolve(text);
      },
      getMergedChange: () => Promise.resolve(change),
      getCommitParents: () => Promise.resolve([BASE]),
      compareChangedFiles: (_ref, base, head) =>
        Promise.resolve(
          base === BASE && head === MERGE ? FILES.map((f) => f.path).sort() : ['other.ts'],
        ),
      getCommitAuthors: () => Promise.resolve(authors),
    },
  });

  /** A tenant with a merged intent (a pushed run, `pr_merged`), its spec and three more people. */
  async function world(merged = true): Promise<World> {
    files = new Map();
    change = {
      mergeCommitSha: MERGE,
      mergeCommitParents: [BASE, '6'.repeat(40)],
      commitCount: 2,
      files: FILES,
    };
    authors = { accounts: [AUTHOR], withoutAccount: 0 };
    const seeded = await seedRun(t.app, {
      slug: `tasks-${String(++tenants)}`,
      models: ['m'],
      now: NOW,
    });
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
      external_id: AUTHOR.id,
      external_login: AUTHOR.login,
    });
    await scope.roleBindings.grant({
      user_id: seeded.personA,
      project_id: seeded.projectId,
      role: 'person_a',
    });
    await scope.specRefs.link(seeded.intentId, {
      path: SPEC.path,
      commitSha: SPEC.commit,
      contentSha256: SPEC.sha256,
      structure: 'spec_kit',
      acceptanceCriteria: 2,
      actorType: 'human',
      actorId: seeded.personA,
    });
    await scope.runEvents.append(seeded.runId, 'branch_pushed', {
      head_sha: '7'.repeat(40),
      parent_sha: BASE,
      diff_sha256: '8'.repeat(64),
      paths_sha256: '9'.repeat(64),
    });
    if (merged) {
      await scope.runEvents.append(seeded.runId, 'pr_merged', {
        pr_number: 12,
        head_sha: '7'.repeat(40),
        merge_commit_sha: MERGE,
      });
    }
    return { ...seeded, reviewer, author, viewer };
  }

  const draft = (w: World, userId = w.personA, taskId = 'tax-rule') =>
    draftEvaluationTask(w.scope, deps(), {
      userId,
      projectId: w.projectId,
      intentCode: w.intentCode,
      taskId,
    });

  /** The drafted card with commands, as a person commits it to the default branch. */
  async function commitCard(w: World, over: Partial<TaskCard> = {}): Promise<string> {
    const card: TaskCard = {
      ...(await draft(w)),
      failToPass: ['pnpm test -- apps/api/src/tax.spec.ts'],
      passToPass: ['pnpm test'],
      ci: ['pnpm lint'],
      ...over,
    };
    const text = renderTaskCard(card);
    files.set('.sdlc/eval-tasks/tax-rule.yaml', text);
    return createHash('sha256').update(text, 'utf8').digest('hex');
  }

  const register = (w: World, userId: string | null = w.personA) =>
    registerEvaluationTask(w.scope, deps(), { userId, projectId: w.projectId, taskId: 'tax-rule' });

  const review = (
    w: World,
    id: string,
    sha: string,
    userId: string,
    decision: 'approved' | 'rejected' = 'approved',
  ) =>
    reviewEvaluationTask(w.scope, deps(), {
      userId,
      id,
      cardSha256: sha,
      decision,
      reason: decision === 'rejected' ? 'tests_weak' : null,
    });

  describe('draft (AC4)', () => {
    it('drafts a card from the merged fixture intent: base, spec, hidden tests', async () => {
      const w = await world();
      expect(await draft(w)).toMatchObject({
        id: 'tax-rule',
        intent: w.intentCode,
        baseCommit: BASE,
        mergeCommit: MERGE,
        spec: SPEC,
        hiddenTests: ['apps/api/src/tax.spec.ts'],
        plannedFiles: ['apps/api/src/tax.ts'],
        failToPass: [],
      });
      // Nothing is stored by a draft.
      expect(await w.scope.evaluationTasks.listForProject(w.projectId)).toEqual([]);
    });

    it('refuses a pull request without a test, a viewer, an unknown or unmerged intent', async () => {
      const w = await world();
      change = { ...change, files: [FILES[0]!] };
      expect(await code(draft(w))).toBe('no_tests');
      change = { ...change, files: FILES };
      expect(await code(draft(w, w.viewer))).toBe('forbidden');
      expect(
        await code(
          draftEvaluationTask(w.scope, deps(), {
            userId: w.personA,
            projectId: w.projectId,
            intentCode: 'INT-2026-999999',
            taskId: 'tax-rule',
          }),
        ),
      ).toBe('intent_not_found');
      expect(await code(draft(await world(false)))).toBe('intent_not_merged');
    });

    it('refuses when the Git host cannot be read (never a guess)', async () => {
      const w = await world();
      const down = deps();
      const failing: EvaluationTaskDeps = {
        gitHost: {
          ...down.gitHost,
          getMergedChange: () => Promise.reject(new GitHostError('timeout')),
        },
      };
      expect(
        await code(
          draftEvaluationTask(w.scope, failing, {
            userId: w.personA,
            projectId: w.projectId,
            intentCode: w.intentCode,
            taskId: 'tax-rule',
          }),
        ),
      ).toBe('git_host_unavailable');
    });
  });

  describe('register (AC1, AC2)', () => {
    it('stores the reference only: path, commit, SHA-256, commits; audited with codes', async () => {
      const w = await world();
      const sha = await commitCard(w);
      const { task, outcome } = await register(w);
      expect(outcome).toBe('created');
      expect(task).toMatchObject({
        task_id: 'tax-rule',
        intent_id: w.intentId,
        card_path: '.sdlc/eval-tasks/tax-rule.yaml',
        card_commit: HEAD,
        card_sha256: sha,
        base_commit: BASE,
        merge_commit: MERGE,
        status: 'registered',
      });
      const [event] = await w.scope.audit.listForEntity(task.id, ['evaluation_task.registered']);
      expect(event!.payload).toEqual({
        project_id: w.projectId,
        task: 'tax-rule',
        intent_id: w.intentId,
        card_sha256: sha,
        card_commit: HEAD,
      });
      // The same card again changes nothing; a changed card goes back to `registered`.
      expect((await register(w)).outcome).toBe('unchanged');
      await w.scope.evaluationTasks.recordCheck(task.id, sha, { status: 'checked' });
      const sha2 = await commitCard(w, { ci: ['pnpm lint', 'pnpm typecheck'] });
      const again = await register(w);
      expect(again).toMatchObject({
        outcome: 'changed',
        task: { status: 'registered', card_sha256: sha2 },
      });
    });

    it('refuses a missing card, an invalid card and a card that does not match its intent', async () => {
      const w = await world();
      expect(await code(register(w))).toBe('card_not_found');
      files.set('.sdlc/eval-tasks/tax-rule.yaml', 'schema: 2\nid: tax-rule\n');
      expect(await code(register(w))).toBe('card_invalid');
      await commitCard(w, { mergeCommit: 'a'.repeat(40) });
      expect(await code(register(w))).toBe('card_invalid');
      await commitCard(w, { spec: { ...SPEC, sha256: 'b'.repeat(64) } });
      expect(await code(register(w))).toBe('card_invalid');
      await commitCard(w);
      expect(await code(register(w, w.viewer))).toBe('forbidden');
    });

    it('never shows a task to another tenant', async () => {
      const w = await world();
      await commitCard(w);
      const { task } = await register(w);
      const other = await world();
      expect(await other.scope.evaluationTasks.getById(task.id)).toBeUndefined();
      expect(await other.scope.evaluationTasks.listForProject(w.projectId)).toEqual([]);
      expect(
        await code(
          listEvaluationTasks(other.scope, { userId: other.personA, projectId: w.projectId }),
        ),
      ).toBe('project_not_found');
      expect(
        (await listEvaluationTasks(w.scope, { userId: w.viewer, projectId: w.projectId })).map(
          (x) => x.task_id,
        ),
      ).toEqual(['tax-rule']);
    });
  });

  describe('review (AC1)', () => {
    async function checked(w: World) {
      const sha = await commitCard(w);
      const { task } = await register(w);
      return { task, sha };
    }

    it('a reviewer with a role who is not a producer approves a checked task', async () => {
      const w = await world();
      const { task, sha } = await checked(w);
      expect(await code(review(w, task.id, sha, w.reviewer))).toBe('task_not_checked');
      expect(await w.scope.evaluationTasks.recordCheck(task.id, sha, { status: 'checked' })).toBe(
        true,
      );
      const approved = await review(w, task.id, sha, w.reviewer);
      expect(approved.status).toBe('approved');
      expect(await w.scope.evaluationTasks.listDecisions(task.id)).toMatchObject([
        { decision: 'approved', card_sha256: sha, decided_by: w.reviewer, reason: null },
      ]);
      const [event] = await w.scope.audit.listForEntity(task.id, ['evaluation_task.approved']);
      expect(event).toMatchObject({
        actor_id: w.reviewer,
        payload: { task: 'tax-rule', card_sha256: sha },
      });
    });

    it('refuses producers (the creator, a commit author), a viewer and a stale card', async () => {
      const w = await world();
      const { task, sha } = await checked(w);
      await w.scope.evaluationTasks.recordCheck(task.id, sha, { status: 'checked' });
      expect(await code(review(w, task.id, sha, w.personA))).toBe('producer_cannot_review');
      expect(await code(review(w, task.id, sha, w.author))).toBe('producer_cannot_review');
      expect(await code(review(w, task.id, sha, w.viewer))).toBe('forbidden');
      expect(await code(review(w, task.id, 'f'.repeat(64), w.reviewer))).toBe('task_changed');
      authors = { accounts: [], withoutAccount: 0 };
      // Without the commit, carol is no producer any more and may reject.
      expect((await review(w, task.id, sha, w.author, 'rejected')).status).toBe('rejected');
      expect(await w.scope.evaluationTasks.listDecisions(task.id)).toMatchObject([
        { decision: 'rejected', reason: 'tests_weak' },
      ]);
    });

    it('fails closed when the commit authors cannot be read', async () => {
      const w = await world();
      const { task, sha } = await checked(w);
      await w.scope.evaluationTasks.recordCheck(task.id, sha, { status: 'checked' });
      const failing: EvaluationTaskDeps = {
        gitHost: {
          ...deps().gitHost,
          getCommitAuthors: () => Promise.reject(new GitHostError('timeout')),
        },
      };
      expect(
        await code(
          reviewEvaluationTask(w.scope, failing, {
            userId: w.reviewer,
            id: task.id,
            cardSha256: sha,
            decision: 'approved',
            reason: null,
          }),
        ),
      ).toBe('git_host_unavailable');
    });
  });

  describe('the database', () => {
    it('decisions are append-only; a gone task is final; the identity never changes', async () => {
      const w = await world();
      const sha = await commitCard(w);
      const { task } = await register(w);
      await w.scope.evaluationTasks.recordCheck(task.id, sha, { status: 'checked' });
      await review(w, task.id, sha, w.reviewer);
      // Decisions are append-only, for the app and the owner alike.
      await expect(
        sql`UPDATE evaluation_task_decisions SET decision = 'rejected' WHERE task_id = ${task.id}`.execute(
          t.appRaw,
        ),
      ).rejects.toThrow();
      await expect(
        sql`DELETE FROM evaluation_task_decisions WHERE task_id = ${task.id}`.execute(t.owner),
      ).rejects.toThrow();
      // The app has no grant on the identity; the owner is refused by the trigger.
      await expect(
        sql`UPDATE evaluation_tasks SET task_id = 'other' WHERE id = ${task.id}`.execute(t.appRaw),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        sql`UPDATE evaluation_tasks SET intent_id = ${w.projectId} WHERE id = ${task.id}`.execute(
          t.owner,
        ),
      ).rejects.toMatchObject({ code: 'SDA24' });
      await expect(
        sql`DELETE FROM evaluation_tasks WHERE id = ${task.id}`.execute(t.owner),
      ).rejects.toThrow();
      // A gone task is final (PR 4 sets it when the card is removed).
      await sql`UPDATE evaluation_tasks SET status = 'gone' WHERE id = ${task.id}`.execute(
        t.appRaw,
      );
      await expect(
        sql`UPDATE evaluation_tasks SET status = 'registered' WHERE id = ${task.id}`.execute(
          t.appRaw,
        ),
      ).rejects.toMatchObject({ code: 'SDA24' });
      expect(await code(register(w))).toBe('task_gone');
    });

    it('the tables hold no text: only codes, IDs, commits and hashes', async () => {
      const w = await world();
      await commitCard(w);
      const { task } = await register(w);
      const values = Object.values(task).filter((v): v is string => typeof v === 'string');
      for (const value of values) expect(value).not.toMatch(/\s/);
    });
  });
});
