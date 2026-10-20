// D-08 L07 PR 3b on PostgreSQL through the API (design/ADR-M85 §2.2, §2.6):
// `/v1/projects/:project/eval-tasks` (list, draft, register) and `/v1/eval-tasks/:id/approve|reject`.
// - AC4: the draft of a merged intent returns the card's fields; no test → 422 `no_tests`;
// - AC1: a reviewer who is not a producer approves a checked task bound to the card's SHA-256;
//   the creator gets 403 `producer_cannot_review`, a viewer 403, someone without a role 404;
// - AC2: another tenant never sees a task; the bodies hold codes, commits, paths and hashes.
import { renderTaskCard } from '@sdlc/eval';
import { t, type MessageKey } from '@sdlc/messages';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { createApp, type ApiDeps } from '../../../apps/api/src/app.js';
import { issueApiToken } from '../../../packages/core/src/admin/tokens.js';
import {
  fakeTaskGitHost,
  seedTaskWorld,
  taskGitState,
  TASK_BASE,
  TASK_FILES,
  TASK_MERGE,
  TASK_NOW,
  type TaskGitState,
  type TaskWorld,
} from '../task-seed.js';
import { tokenIssuedAt } from '../token-clock.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

describeDb('L07 PR 3b: evaluation tasks through the API', () => {
  let db: TestDatabase;
  let app: Awaited<ReturnType<typeof createApp>>;
  let w: TaskWorld;
  let other: TaskWorld;
  const git: TaskGitState = taskGitState();
  const tokens: Record<string, string> = {};

  beforeAll(async () => {
    db = await createTestDatabase();
    w = await seedTaskWorld(db.app, 'api-tasks');
    other = await seedTaskWorld(db.app, 'api-tasks-other');
    const people = { a: w.personA, reviewer: w.reviewer, viewer: w.viewer };
    for (const [key, id] of Object.entries(people)) {
      tokens[key] = (
        await issueApiToken(w.scope, { userId: id, name: key, now: tokenIssuedAt() })
      ).token;
    }
    tokens.other = (
      await issueApiToken(other.scope, { userId: other.personA, name: 'o', now: tokenIssuedAt() })
    ).token;
    app = await createApp({
      db: db.app as unknown as ApiDeps['db'],
      settings: { rateLimitPerMinute: 1000, authFailuresPerMinute: 1000 },
      now: () => TASK_NOW,
      evalTaskGitHost: fakeTaskGitHost(git),
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  const call = async (method: 'GET' | 'POST', url: string, who: string, body?: unknown) => {
    const reply = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method,
        url,
        headers: { authorization: `Bearer ${tokens[who]!}` },
        ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
      });
    return { status: reply.statusCode, body: reply.json<Record<string, unknown>>() };
  };
  const refusal = (
    reply: { status: number; body: Record<string, unknown> },
    status: number,
    code: string,
    reason?: string,
  ) => {
    expect(reply.status, JSON.stringify(reply.body)).toBe(status);
    const error = reply.body.error as Record<string, unknown>;
    expect(error.code).toBe(code);
    if (reason !== undefined) {
      expect(error.reason).toBe(reason);
      expect(error.reason_message).toBe(t(`evaluation.error.${reason}` as MessageKey));
    }
  };
  const draftUrl = (intent: string) =>
    `/v1/projects/shop/eval-tasks/draft?intent=${intent}&task=tax-rule`;

  it('drafts a card from a merged intent and stores nothing (AC4)', async () => {
    const reply = await call('GET', draftUrl(w.intentCode), 'a');
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(reply.body.card).toMatchObject({
      id: 'tax-rule',
      intent: w.intentCode,
      base_commit: TASK_BASE,
      merge_commit: TASK_MERGE,
      hidden_tests: ['apps/api/src/tax.spec.ts'],
      planned_files: ['apps/api/src/tax.ts'],
    });
    expect((await call('GET', '/v1/projects/shop/eval-tasks', 'a')).body).toEqual({ tasks: [] });
  });

  it('refuses a change without a test, a viewer, a bad query', async () => {
    git.change = { ...git.change, files: [TASK_FILES[0]!] };
    refusal(await call('GET', draftUrl(w.intentCode), 'a'), 422, 'evaluation_refused', 'no_tests');
    git.change = { ...git.change, files: TASK_FILES };
    refusal(await call('GET', draftUrl(w.intentCode), 'viewer'), 403, 'forbidden');
    refusal(
      await call('GET', '/v1/projects/shop/eval-tasks/draft?intent=x&task=tax-rule', 'a'),
      400,
      'invalid_request',
    );
  });

  it('registers, lists, and a reviewer who is not a producer approves (AC1, AC2)', async () => {
    const draft = await call('GET', draftUrl(w.intentCode), 'a');
    const card = draft.body.card as Record<string, unknown>;
    git.files.set(
      '.sdlc/eval-tasks/tax-rule.yaml',
      renderTaskCard({
        id: 'tax-rule',
        intent: w.intentCode,
        baseCommit: card.base_commit as string,
        mergeCommit: card.merge_commit as string,
        spec: card.spec as { path: string; commit: string; sha256: string },
        hiddenTests: card.hidden_tests as string[],
        plannedFiles: card.planned_files as string[],
        failToPass: ['pnpm test -- apps/api/src/tax.spec.ts'],
        passToPass: ['pnpm test'],
        ci: ['pnpm lint'],
      }),
    );
    const registered = await call('POST', '/v1/projects/shop/eval-tasks', 'a', {
      task: 'tax-rule',
    });
    expect(registered.status, JSON.stringify(registered.body)).toBe(200);
    expect(registered.body).toMatchObject({
      outcome: 'created',
      task: { task: 'tax-rule', intent: w.intentCode, status: 'registered', check_code: null },
    });
    const task = registered.body.task as { id: string; card_sha256: string };

    // Another tenant never sees the task (its own project `shop` is empty); the viewer reads it.
    expect((await call('GET', '/v1/projects/shop/eval-tasks', 'other')).body).toEqual({
      tasks: [],
    });
    const listed = await call('GET', '/v1/projects/shop/eval-tasks', 'viewer');
    expect(listed.body).toMatchObject({ tasks: [{ id: task.id, card_sha256: task.card_sha256 }] });

    const approve = (who: string, sha = task.card_sha256) =>
      call('POST', `/v1/eval-tasks/${task.id}/approve`, who, { card_sha256: sha });
    refusal(await approve('reviewer'), 409, 'evaluation_conflict', 'task_not_checked');
    await w.scope.evaluationTasks.recordCheck(task.id, task.card_sha256, { status: 'checked' });
    refusal(await approve('a'), 403, 'forbidden', 'producer_cannot_review');
    refusal(await approve('viewer'), 403, 'forbidden', 'forbidden');
    refusal(await approve('other'), 404, 'not_found');
    refusal(await approve('reviewer', 'f'.repeat(64)), 409, 'evaluation_conflict', 'task_changed');
    refusal(
      await call('POST', `/v1/eval-tasks/${task.id}/reject`, 'reviewer', {
        card_sha256: task.card_sha256,
        reason: 'because I say so',
      }),
      400,
      'invalid_request',
    );
    const approved = await approve('reviewer');
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body).toMatchObject({ task: { status: 'approved' } });
    // No body holds text: codes, IDs, commits, the card path and hashes.
    for (const value of Object.values(approved.body.task as Record<string, unknown>)) {
      if (typeof value === 'string') expect(value).not.toMatch(/\s/);
    }
  }, 30_000);

  it('answers 503 without a Git host, but still lists', async () => {
    const bare = await createApp({
      db: db.app as unknown as ApiDeps['db'],
      settings: { rateLimitPerMinute: 1000, authFailuresPerMinute: 1000 },
      now: () => TASK_NOW,
    });
    try {
      const inject = (method: 'GET' | 'POST', url: string, body?: Record<string, unknown>) =>
        bare
          .getHttpAdapter()
          .getInstance()
          .inject({
            method,
            url,
            headers: { authorization: `Bearer ${tokens.a!}` },
            ...(body ? { payload: body } : {}),
          });
      expect((await inject('GET', draftUrl(w.intentCode))).statusCode).toBe(503);
      expect(
        (await inject('POST', '/v1/projects/shop/eval-tasks', { task: 'tax-rule' })).statusCode,
      ).toBe(503);
      expect((await inject('GET', '/v1/projects/shop/eval-tasks')).statusCode).toBe(200);
    } finally {
      await bare.close();
    }
  });
});
