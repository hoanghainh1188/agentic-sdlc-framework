// D-08 C08 PR 1 on a live PostgreSQL, without Temporal (design/ADR-M38 §2.1–§2.6, QUESTIONS #52,
// #134, #155, #156). The test plays the runner's push (it appends `branch_pushed` and records the
// pushed head, as `publishRun` does); the runner's own code is tested in `publish-run.test.ts`.
// - G6 waits for the G5 block window, then asks for the push (`publish` / `push`);
// - `preparePublish` issues a `contents: write` token for the project's repository and wraps it
//   (the raw token never leaves the worker);
// - after the push the step asks for the pull request (`open_pr`); `finishPublish` opens it with
//   the T2 body filled from codes only, links it (`intents.pr_number`, audit `intent.pr_linked`,
//   notice `pr_opened`) and is idempotent; then G6 waits for CI (`ci_pending`);
// - a refusal (`empty_diff`, `branch_moved`) or `MAX_PUBLISH_ATTEMPTS` failures → paused at G6 and
//   a `technical` escalation (#156); `resume` → G4, `modify` → G3, `terminate` → cancelled;
// - the next run starts from the pushed commit (#134);
// - migration 0017: `runs.head_sha` is written once, on a succeeded run only.
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import type {
  NewPullRequest,
  PullRequestInfo,
  RepoRef,
} from '../../../packages/contracts/src/index.js';
import { DbError } from '../../../packages/core/src/db/errors.js';
import type { Intent } from '../../../packages/core/src/db/schema.js';
import {
  acknowledgeEscalation,
  decideEscalation,
} from '../../../packages/core/src/escalation/decide.js';
import { gatherG4Facts } from '../../../packages/core/src/workflow/g4-proposal.js';
import {
  abandonPublish,
  finishPublish,
  preparePublish,
  type PublishDeps,
} from '../../../packages/core/src/workflow/publish.js';
import { MAX_PUBLISH_ATTEMPTS } from '../../../packages/core/src/workflow/publish-state.js';
import { finishRun, startRun } from '../../../packages/core/src/workflow/run-lifecycle.js';
import { stepIntent } from '../../../packages/core/src/workflow/step.js';
import {
  atG4,
  BASE_1,
  HOUR,
  harness,
  MODEL,
  notices,
  Secret,
  T0,
  type Harness,
} from '../g4-harness.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

const DAY = 24 * HOUR;
const PATHS = 'a'.repeat(64);
const DIFF = 'd'.repeat(64);
const HEAD = 'e'.repeat(40);

interface GitCalls {
  tokens: { repo: RepoRef; permissions: unknown }[];
  opened: { repo: RepoRef; input: NewPullRequest }[];
  wrapped: { fields: string[]; ttl: number }[];
  /** The pull request `findOpenPullRequest` answers (null: none). */
  existing: PullRequestInfo | null;
  /** The head SHA of the pull requests the fake opens. */
  prHead: string;
}

function prInfo(number: number, headSha: string): PullRequestInfo {
  return {
    number,
    state: 'open',
    draft: false,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headSha,
    headRef: 'agent/INT-x',
    baseRef: 'main',
    author: { id: '1', login: 'sdlc[bot]', type: 'bot' },
    mergedBy: null,
    changedFiles: 2,
    url: `https://github.com/acme/shop/pull/${String(number)}`,
  };
}

describeDb('C08 PR 1: the push and the pull request at G6, on PostgreSQL', () => {
  let db: TestDatabase;
  let t: Harness;
  let calls: GitCalls;
  let deps: PublishDeps;

  beforeAll(async () => {
    db = await createTestDatabase();
    t = await harness(db);
  }, 60_000);

  afterAll(async () => {
    await t?.f.close();
    await db?.drop();
  });

  beforeEach(async () => {
    t.setClock(T0);
    Object.assign(t.world, { base: BASE_1, models: [MODEL], gitDown: false, tenantBudget: null });
    await t.setConfig(`run:\n  agent_key: ${t.agent.key}\n`);
    calls = { tokens: [], opened: [], wrapped: [], existing: null, prHead: HEAD };
    deps = {
      registry: t.f.registry,
      gitHost: {
        issueShortLivedToken: (repo, scope) => {
          calls.tokens.push({ repo, permissions: scope.permissions });
          return Promise.resolve({
            token: new Secret('ghs_push_token'),
            expiresAt: T0.toISOString(),
            repo,
            permissions: scope.permissions,
          });
        },
        findOpenPullRequest: () => Promise.resolve(calls.existing),
        openPullRequest: (repo, input) => {
          calls.opened.push({ repo, input });
          return Promise.resolve(prInfo(12 + calls.opened.length, calls.prHead));
        },
      },
      wrapper: {
        wrap: (fields, options) => {
          calls.wrapped.push({ fields: Object.keys(fields), ttl: options.ttlSeconds });
          return Promise.resolve(new Secret('wrapping-token'));
        },
      },
    };
  });

  const reload = (intent: Intent) => t.reload(intent);
  const step = async (intent: Intent) => {
    for (let i = 0; i < 12; i += 1) {
      const result = await stepIntent(
        t.f.scope,
        { registry: t.f.registry, g4: t.g4, startRuns: true, publish: true },
        intent.id,
      );
      if (result.outcome !== 'moved') return result;
    }
    throw new Error('the step never settled');
  };

  /** A Medium intent whose succeeded run passed G5 (HOTL); waits at G6. Returns the run. */
  async function atG6(): Promise<{ intent: Intent; runId: string }> {
    const intent = await atG4(t, 'medium');
    expect(await step(intent)).toEqual({ outcome: 'run_prepare' });
    const started = await startRun(t.f.scope, t.runDeps, intent.id);
    if (!started.ok) throw new Error(`not started: ${started.reason}`);
    const runId = started.run.runId;
    const now = new Date();
    await t.f.scope.runs.claimForProvisioning(runId, now);
    await t.f.scope.runs.transition(runId, { from: ['provisioning'], to: 'running', now });
    await t.f.scope.runEvents.append(runId, 'diff_stored', {
      sha256: DIFF,
      size_bytes: 120,
      changed_files: 2,
    });
    await t.f.scope.runEvents.append(runId, 'changes_checked', {
      changed_files: 2,
      out_of_scope: 0,
      instruction_files: 0,
      paths_sha256: PATHS,
    });
    await t.f.scope.runs.transition(runId, {
      from: ['running'],
      to: 'succeeded',
      now,
      finishedAt: now,
    });
    expect(await step(intent)).toEqual({ outcome: 'run_ended', runId });
    await finishRun(t.f.scope, t.runDeps, intent.id, runId);
    expect(await step(intent)).toMatchObject({ outcome: 'waiting', reason: 'later_gate' });
    expect(await reload(intent)).toMatchObject({ status: 'in_gate', current_gate: 'G6' });
    return { intent, runId };
  }

  /** What the runner records after a push (`publishRun`). */
  async function playPush(runId: string, head = HEAD, parent = BASE_1): Promise<void> {
    await t.f.scope.transaction(async (tx) => {
      await tx.runEvents.append(runId, 'branch_pushed', {
        head_sha: head,
        parent_sha: parent,
        diff_sha256: DIFF,
        paths_sha256: PATHS,
      });
      expect(await tx.runs.recordPushedHead(runId, head, new Date())).toBe(true);
    });
  }

  async function decide(intent: Intent, decision: 'resume' | 'modify' | 'terminate') {
    const escalation = (await t.f.scope.escalations.listForIntent(intent.id)).at(-1)!;
    await acknowledgeEscalation(t.f.scope, { escalationId: escalation.id, actorId: t.f.users.b });
    await decideEscalation(t.f.scope, {
      escalationId: escalation.id,
      actorId: t.f.users.b,
      decision,
    });
  }

  it('waits for the G5 block window, then pushes, opens the pull request and waits for CI', async () => {
    const { intent, runId } = await atG6();
    // Within the G5 block window nothing is pushed: the token is never asked for.
    expect(await preparePublish(t.f.scope, deps, intent.id, runId)).toEqual({
      ok: false,
      reason: 'not_ready',
    });
    expect(calls.tokens).toEqual([]);

    t.setClock(new Date(T0.getTime() + 3 * DAY));
    expect(await step(intent)).toEqual({ outcome: 'publish', runId, step: 'push' });
    const prepared = await preparePublish(t.f.scope, deps, intent.id, runId);
    expect(prepared.ok).toBe(true);
    expect(calls.tokens).toEqual([
      { repo: expect.objectContaining({}) as RepoRef, permissions: { contents: 'write' } },
    ]);
    expect(calls.wrapped).toEqual([{ fields: ['token'], ttl: 600 }]);

    // Before the push, there is no pull request to open.
    expect(await finishPublish(t.f.scope, deps, intent.id, runId)).toEqual({
      ok: false,
      reason: 'not_ready',
    });
    await playPush(runId);
    expect(await step(intent)).toEqual({ outcome: 'publish', runId, step: 'open_pr' });
    expect(await finishPublish(t.f.scope, deps, intent.id, runId)).toEqual({
      ok: true,
      prNumber: 13,
    });
    const linked = await reload(intent);
    expect(linked.pr_number).toBe(13);
    expect(await notices(t, intent)).toContain('pr_opened');
    const audit = await t.f.scope.audit.listForEntity(intent.id, ['intent.pr_linked']);
    expect(audit.map((e) => e.payload)).toEqual([{ run_id: runId, pr_number: 13, head_sha: HEAD }]);

    // The T2 body: codes, IDs and hashes; never the intent's title or description.
    const [opened] = calls.opened;
    expect(opened?.input).toMatchObject({ head: `agent/${intent.code}`, base: 'main' });
    expect(opened?.input.title).toBe(
      `${intent.code}: changes of the agent run ${runId.slice(0, 8)}`,
    );
    expect(opened?.input.body).toContain(intent.code);
    expect(opened?.input.body).toContain(runId);
    expect(opened?.input.body).toContain(DIFF);
    expect(opened?.input.body).toContain('- [x] AI wrote **most / all** of this change');
    expect(opened?.input.body).toContain('- [ ] A human reviewed every file');
    expect(opened?.input.body).not.toContain(intent.title);
    if (intent.description) expect(opened?.input.body).not.toContain(intent.description);

    expect(await step(intent)).toEqual({ outcome: 'waiting', reason: 'ci_pending' });
    // Idempotent: a repeated call opens nothing new.
    expect(await finishPublish(t.f.scope, deps, intent.id, runId)).toEqual({
      ok: true,
      prNumber: 13,
    });
    expect(calls.opened).toHaveLength(1);
    // Nothing runs the push again once it is recorded.
    expect(await preparePublish(t.f.scope, deps, intent.id, runId)).toMatchObject({ ok: false });
  });

  it('finds an open pull request instead of opening a second one', async () => {
    const { intent, runId } = await atG6();
    t.setClock(new Date(T0.getTime() + 3 * DAY));
    await playPush(runId);
    calls.existing = prInfo(41, HEAD);
    expect(await finishPublish(t.f.scope, deps, intent.id, runId)).toEqual({
      ok: true,
      prNumber: 41,
    });
    expect(calls.opened).toEqual([]);
  });

  it('a pull request that keeps showing another commit: counted retries, then paused with a technical escalation', async () => {
    const { intent, runId } = await atG6();
    t.setClock(new Date(T0.getTime() + 3 * DAY));
    await playPush(runId);
    calls.prHead = 'f'.repeat(40);
    // GitHub may show the old head for a moment after a push: each mismatch is a counted retry.
    for (let i = 0; i < MAX_PUBLISH_ATTEMPTS; i += 1) {
      expect(await step(intent)).toEqual({ outcome: 'publish', runId, step: 'open_pr' });
      expect(await finishPublish(t.f.scope, deps, intent.id, runId)).toEqual({
        ok: false,
        reason: 'pr_failed',
      });
    }
    expect(await step(intent)).toEqual({ outcome: 'waiting', reason: 'publish_review' });
    expect(await reload(intent)).toMatchObject({
      status: 'paused',
      current_gate: 'G6',
      pr_number: null,
    });
    const [escalation] = await t.f.scope.escalations.listForIntent(intent.id);
    expect(escalation).toMatchObject({ route: 'technical', response_level: 'pause' });
    expect(escalation?.packet).toMatchObject({
      gate: 'G6',
      subject_kind: 'diff',
      subject_sha256: DIFF,
    });
    expect(await notices(t, intent)).toContain('g6_publish_stopped');
    const stopped = await t.f.scope.audit.listForEntity(intent.id, ['gate.g6_publish_stopped']);
    expect(stopped.map((e) => (e.payload as { reason: string }).reason)).toEqual([
      'publish_attempts',
    ]);

    // `terminate` closes the intent.
    await decide(intent, 'terminate');
    expect(await step(intent)).toEqual({ outcome: 'finished', status: 'cancelled' });
  });

  it('the runner refused (empty_diff): paused; resume → G4, and the next run starts from main', async () => {
    const { intent, runId } = await atG6();
    t.setClock(new Date(T0.getTime() + 3 * DAY));
    await t.f.scope.runEvents.append(runId, 'publish_refused', { reason: 'empty_diff' });
    expect(await step(intent)).toEqual({ outcome: 'waiting', reason: 'publish_review' });
    await decide(intent, 'resume');
    // Back at G4, which passes again (POLICY at Medium): a new run.
    expect(await step(intent)).toEqual({ outcome: 'run_prepare' });
    expect(await reload(intent)).toMatchObject({ current_gate: 'G4' });
    expect(await notices(t, intent)).toContain('run_resumed');
    // Nothing was pushed: the next run starts from the default branch (QUESTIONS #109).
    t.world.base = '2'.repeat(40);
    expect((await gatherG4Facts(t.f.scope, t.g4, await reload(intent))).baseSha).toBe(
      '2'.repeat(40),
    );
  });

  it('modify → G3 (HITL from then on)', async () => {
    const { intent, runId } = await atG6();
    t.setClock(new Date(T0.getTime() + 3 * DAY));
    await t.f.scope.runEvents.append(runId, 'publish_refused', { reason: 'diff_mismatch' });
    await step(intent);
    await decide(intent, 'modify');
    await step(intent);
    expect(await reload(intent)).toMatchObject({ status: 'in_gate', current_gate: 'G3' });
    expect(await notices(t, intent)).toContain('g6_returned');
  });

  it(`stops after ${String(MAX_PUBLISH_ATTEMPTS)} failed attempts (a lost runner counts)`, async () => {
    const { intent, runId } = await atG6();
    t.setClock(new Date(T0.getTime() + 3 * DAY));
    await abandonPublish(t.f.scope, intent.id, runId);
    for (let i = 1; i < MAX_PUBLISH_ATTEMPTS; i += 1) {
      expect(await step(intent)).toEqual({ outcome: 'publish', runId, step: 'push' });
      await t.f.scope.runEvents.append(runId, 'publish_failed', { reason: 'push_rejected' });
    }
    expect(await step(intent)).toEqual({ outcome: 'waiting', reason: 'publish_review' });
    const stopped = await t.f.scope.audit.listForEntity(intent.id, ['gate.g6_publish_stopped']);
    expect(stopped.map((e) => (e.payload as { reason: string }).reason)).toEqual([
      'publish_attempts',
    ]);
  });

  it('a push token that cannot be issued is a counted failure (never an endless retry)', async () => {
    const { intent, runId } = await atG6();
    t.setClock(new Date(T0.getTime() + 3 * DAY));
    deps = {
      ...deps,
      gitHost: {
        ...deps.gitHost,
        issueShortLivedToken: () => Promise.reject(new Error('the App lacks contents: write')),
      },
    };
    for (let i = 0; i < MAX_PUBLISH_ATTEMPTS; i += 1) {
      expect(await step(intent)).toEqual({ outcome: 'publish', runId, step: 'push' });
      expect(await preparePublish(t.f.scope, deps, intent.id, runId)).toEqual({
        ok: false,
        reason: 'token_failed',
      });
    }
    expect(await step(intent)).toEqual({ outcome: 'waiting', reason: 'publish_review' });
  });

  it('a frozen intent does not push', async () => {
    const { intent, runId } = await atG6();
    t.setClock(new Date(T0.getTime() + 3 * DAY));
    await t.f.scope.runEvents.append(runId, 'publish_refused', { reason: 'empty_diff' });
    await step(intent); // paused, with an open escalation that freezes the intent
    expect(await preparePublish(t.f.scope, deps, intent.id, runId)).toMatchObject({ ok: false });
    expect(calls.tokens).toEqual([]);
  });

  it('QUESTIONS #134: after a push, the next run of the intent starts from the pushed commit', async () => {
    const { intent, runId } = await atG6();
    t.setClock(new Date(T0.getTime() + 3 * DAY));
    await playPush(runId);
    t.world.base = '2'.repeat(40);
    expect((await gatherG4Facts(t.f.scope, t.g4, await reload(intent))).baseSha).toBe(HEAD);
  });

  it('migration 0017: head_sha is written once, on a succeeded run only; a final run stays final', async () => {
    const { runId } = await atG6();
    await playPush(runId);
    expect(await t.f.scope.runs.recordPushedHead(runId, HEAD, new Date())).toBe(true);
    expect(await t.f.scope.runs.recordPushedHead(runId, 'f'.repeat(40), new Date())).toBe(false);
    expect((await t.f.scope.runs.getById(runId))?.head_sha).toBe(HEAD);
    await expect(
      t.f.scope.runs.transition(runId, { from: ['succeeded'], to: 'failed', now: new Date() }),
    ).rejects.toBeInstanceOf(DbError);
  });
});
