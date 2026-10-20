// D-08 L07 PR 4a on PostgreSQL (design/ADR-M85 §2.5, §2.8, QUESTIONS #488): the worker's side of
// a task check (AC3).
// - `prepareTaskCheck`: a registered task becomes `checking`, its signed contract is stored and a
//   wrapped token is made; a removed card makes the task `gone`; a changed card fails the check;
// - `verifyTaskCheckContract`: a good contract passes; a bad signature, an expired contract, a
//   changed contract and a task no longer `checking` are refused;
// - `finishTaskCheck`: `checked`, `check_failed` with its code, audited with codes; a lost check
//   goes back to `registered`, and fails with `check_lost` after three hand-overs;
// - `TaskCheckLoop`: hands registered tasks to the dispatcher, requeues a check without workflow;
// - the contracts table is append-only and holds no path.
import crypto from 'node:crypto';

import type {
  CheckEvaluationTaskInput,
  EvaluationTaskCheckDispatcher,
  RunContractSigner,
  RunContractVerifier,
} from '@sdlc/contracts';
import { renderTaskCard, type TaskCard } from '@sdlc/eval';
import { Redacted } from '@sdlc/secrets';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TaskCheckLoop } from '../../../apps/worker/src/evaluation-task-check-loop.js';
import {
  draftEvaluationTask,
  finishTaskCheck,
  MAX_TASK_CHECK_ATTEMPTS,
  prepareTaskCheck,
  registerEvaluationTask,
  verifyTaskCheckContract,
  type TaskCheckDeps,
} from '../../../packages/core/src/evaluation/index.js';
import {
  fakeTaskGitHost,
  seedTaskWorld,
  taskGitState,
  TASK_NOW,
  type TaskGitState,
  type TaskWorld,
} from '../task-seed.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

const CARD_PATH = '.sdlc/eval-tasks/tax-rule.yaml';

class FakeTransit implements RunContractSigner, RunContractVerifier {
  readonly signed = new Map<string, string>();
  sign(bytes: Uint8Array) {
    const signature = `vault:v1:${crypto.randomBytes(48).toString('base64')}`;
    this.signed.set(Buffer.from(bytes).toString('hex'), signature);
    return Promise.resolve({ signature, keyVersion: 1 });
  }
  publicKey() {
    return Promise.reject(new Error('not used'));
  }
  verify(bytes: Uint8Array, signature: string) {
    return Promise.resolve(this.signed.get(Buffer.from(bytes).toString('hex')) === signature);
  }
}

class FakeDispatcher implements EvaluationTaskCheckDispatcher {
  readonly started: CheckEvaluationTaskInput[] = [];
  readonly live = new Set<string>();
  start(input: CheckEvaluationTaskInput) {
    this.started.push(input);
    this.live.add(`${input.evaluationTaskId}/${String(input.attempt)}`);
    return Promise.resolve();
  }
  isRunning(ref: { evaluationTaskId: string; attempt: number }) {
    return Promise.resolve(this.live.has(`${ref.evaluationTaskId}/${String(ref.attempt)}`));
  }
}

const silent = { log: () => undefined };

describeDb('L07 PR 4a: the worker side of a task check on PostgreSQL', () => {
  let t: TestDatabase;
  let tenants = 0;
  let git: TaskGitState;
  const transit = new FakeTransit();

  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  });

  const deps = (now = TASK_NOW): TaskCheckDeps => {
    const host = fakeTaskGitHost(git);
    return {
      signer: transit,
      gitHost: {
        getBranchHead: host.getBranchHead,
        getFileAtCommit: host.getFileAtCommit,
        issueShortLivedToken: () =>
          Promise.resolve({
            token: new Redacted('ghs_canary'),
            expiresAt: now,
          } as unknown as Awaited<ReturnType<TaskCheckDeps['gitHost']['issueShortLivedToken']>>),
      },
      wrapper: { wrap: () => Promise.resolve(new Redacted('wrap-token')) },
      now: () => now,
    };
  };

  /** A tenant with a registered task (its card on the default branch). */
  async function registered(): Promise<{ w: TaskWorld; id: string; sha: string }> {
    git = taskGitState();
    const w = await seedTaskWorld(t.app, `check-${String(++tenants)}`);
    const taskDeps = { gitHost: fakeTaskGitHost(git) };
    const card: TaskCard = {
      ...(await draftEvaluationTask(w.scope, taskDeps, {
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
    const { task } = await registerEvaluationTask(w.scope, taskDeps, {
      userId: w.personA,
      projectId: w.projectId,
      taskId: 'tax-rule',
    });
    return { w, id: task.id, sha: task.card_sha256 };
  }

  describe('prepareTaskCheck', () => {
    it('takes a registered task to checking, with a stored contract and a wrapped token', async () => {
      const { w, id, sha } = await registered();
      const result = await prepareTaskCheck(w.scope, deps(), id);
      expect(result).toEqual({
        ok: true,
        input: {
          tenantId: w.scope.tenantId,
          evaluationTaskId: id,
          cardSha256: sha,
          attempt: 1,
          wrappedGitToken: 'wrap-token',
        },
      });
      expect(await w.scope.evaluationTasks.getById(id)).toMatchObject({
        status: 'checking',
        check_attempt: 1,
      });
      const stored = await w.scope.evaluationTaskCheckContracts.get(id, sha, 1);
      expect(stored?.contract_json).toMatchObject({
        kind: 'evaluation_task_check',
        evaluation_task_id: id,
        repo: 'org/pilot-order-inventory',
        task_id: 'tax-rule',
        card_sha256: sha,
        attempt: 1,
      });
      // No path of the project or the spec, no token in the contract.
      expect(JSON.stringify(stored?.contract_json)).not.toMatch(/\.ts|\.md|ghs_|wrap-/);
      // Only a registered task is prepared.
      expect(await prepareTaskCheck(w.scope, deps(), id)).toEqual({
        ok: false,
        reason: 'not_startable',
      });
    });

    it('a removed card makes the task gone; a changed card fails the check', async () => {
      const first = await registered();
      git.files.delete(CARD_PATH);
      expect(await prepareTaskCheck(first.w.scope, deps(), first.id)).toEqual({
        ok: false,
        reason: 'gone',
      });
      expect((await first.w.scope.evaluationTasks.getById(first.id))?.status).toBe('gone');
      const [gone] = await first.w.scope.audit.listForEntity(first.id, ['evaluation_task.gone']);
      expect(gone?.payload).toEqual({ project_id: first.w.projectId, task: 'tax-rule' });

      const second = await registered();
      git.files.set(CARD_PATH, `${git.files.get(CARD_PATH)!}# changed\n`);
      expect(await prepareTaskCheck(second.w.scope, deps(), second.id)).toEqual({
        ok: false,
        reason: 'card_changed',
      });
      expect(await second.w.scope.evaluationTasks.getById(second.id)).toMatchObject({
        status: 'check_failed',
        check_code: 'card_changed',
      });
    });
  });

  describe('verifyTaskCheckContract', () => {
    it('passes a good contract and refuses bad ones', async () => {
      const { w, id, sha } = await registered();
      await prepareTaskCheck(w.scope, deps(), id);
      const stored = (await w.scope.evaluationTaskCheckContracts.get(id, sha, 1))!;
      const envelope = { contract: stored.contract_json, signature: stored.signature };
      const verify = (env: unknown, now = TASK_NOW) =>
        verifyTaskCheckContract(t.app, env, { verifier: transit, now: () => now });
      expect(await verify(envelope)).toMatchObject({ ok: true, task: { id, status: 'checking' } });
      expect(await verify({ ...envelope, signature: 'vault:v1:AAAA' })).toEqual({
        ok: false,
        reason: 'bad_signature',
      });
      expect(
        await verify({ contract: { ...stored.contract_json, extra: 1 }, signature: 'x' }),
      ).toEqual({
        ok: false,
        reason: 'malformed',
      });
      expect(await verify(envelope, new Date(TASK_NOW.getTime() + 24 * 3_600_000))).toEqual({
        ok: false,
        reason: 'expired',
      });
      await finishTaskCheck(w.scope, {
        evaluationTaskId: id,
        cardSha256: sha,
        attempt: 1,
        end: { outcome: 'checked' },
      });
      expect(await verify(envelope)).toEqual({ ok: false, reason: 'run_not_startable' });
    });
  });

  describe('finishTaskCheck', () => {
    it('records checked and check_failed with codes; idempotent', async () => {
      const { w, id, sha } = await registered();
      await prepareTaskCheck(w.scope, deps(), id);
      const finish = (end: Parameters<typeof finishTaskCheck>[1]['end'], attempt = 1) =>
        finishTaskCheck(w.scope, { evaluationTaskId: id, cardSha256: sha, attempt, end });
      await finish({ outcome: 'check_failed', code: 'passes_without_change' });
      await finish({ outcome: 'checked' });
      expect(await w.scope.evaluationTasks.getById(id)).toMatchObject({
        status: 'check_failed',
        check_code: 'passes_without_change',
      });
      const events = await w.scope.audit.listForEntity(id, ['evaluation_task.checked']);
      expect(events.map((e) => e.payload)).toEqual([
        {
          project_id: w.projectId,
          task: 'tax-rule',
          card_sha256: sha,
          result: 'check_failed',
          attempt: 1,
          code: 'passes_without_change',
        },
      ]);
    });

    it('a lost check is handed over again, and fails with check_lost after three', async () => {
      const { w, id, sha } = await registered();
      for (let attempt = 1; attempt <= MAX_TASK_CHECK_ATTEMPTS; attempt += 1) {
        const prepared = await prepareTaskCheck(w.scope, deps(), id);
        expect(prepared).toMatchObject({ ok: true, input: { attempt } });
        await finishTaskCheck(w.scope, {
          evaluationTaskId: id,
          cardSha256: sha,
          attempt,
          end: { outcome: 'lost' },
        });
        expect((await w.scope.evaluationTasks.getById(id))?.status).toBe('registered');
      }
      expect(await prepareTaskCheck(w.scope, deps(), id)).toEqual({
        ok: false,
        reason: 'check_lost',
      });
      expect(await w.scope.evaluationTasks.getById(id)).toMatchObject({
        status: 'check_failed',
        check_code: 'check_lost',
      });
    });
  });

  describe('TaskCheckLoop', () => {
    it('hands registered tasks over and requeues a check without workflow', async () => {
      const { w, id, sha } = await registered();
      const dispatcher = new FakeDispatcher();
      const loop = new TaskCheckLoop({
        // Only this test's tenant. The test imports core from its sources, the worker from the
        // build: same shapes.
        listTenants: () => Promise.resolve([w.scope.tenantId] as unknown as never[]),
        forTenant: (tenantId) => t.app.forTenant(tenantId as unknown as never) as unknown as never,
        prepare: (scope, taskId) => prepareTaskCheck(scope as unknown as never, deps(), taskId),
        dispatcher,
        logger: silent,
        maxInFlight: 10,
      });
      const first = await loop.pass();
      expect(first.handedOver).toBe(1);
      expect(dispatcher.started.some((s) => s.evaluationTaskId === id)).toBe(true);
      // The workflow is gone (the worker stopped): the next pass requeues, the one after hands over.
      dispatcher.live.clear();
      const second = await loop.pass();
      expect(second).toMatchObject({ requeued: 1, handedOver: 1 });
      expect((await w.scope.evaluationTasks.getById(id))?.status).toBe('checking');
      expect((await w.scope.evaluationTasks.getById(id))?.check_attempt).toBe(2);
      expect(await w.scope.evaluationTaskCheckContracts.get(id, sha, 2)).toBeDefined();
    });
  });

  it('the contracts table is append-only', async () => {
    const { w, id } = await registered();
    await prepareTaskCheck(w.scope, deps(), id);
    await expect(
      sql`UPDATE evaluation_task_check_contracts SET attempt = 9 WHERE evaluation_task_id = ${id}`.execute(
        t.appRaw,
      ),
    ).rejects.toThrow();
    await expect(
      sql`DELETE FROM evaluation_task_check_contracts WHERE evaluation_task_id = ${id}`.execute(
        t.owner,
      ),
    ).rejects.toThrow();
  });
});
