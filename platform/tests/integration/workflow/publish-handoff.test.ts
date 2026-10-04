// D-08 C08 PR 1 on Temporal (design/ADR-M38 §2.1–§2.5, QUESTIONS #52, #156): the time-skipping
// test server with a throw-away PostgreSQL. Run with `pnpm test:workflow`.
//
// - G5 passes (HOTL) → G6 waits for the G5 block window → `preparePublish` → `publishRun` on the
//   task queue `sdlc-runner` → `finishPublish` → the pull request is linked → G6 waits for CI;
// - the history holds the push token's single-use wrapping token, never the token itself, and
//   replays on the current code;
// - a lost runner during the push (the activity fails) counts as a failed attempt
//   (`runner_lost`); the next attempt pushes;
// - repeated failures stop the push: paused at G6 with a `technical` escalation (QUESTIONS #156);
// - E01 (ADR-M41): CI passes → G7; Person B's review of the pushed commit and Person B's merge
//   → G8; the history replays;
// - E03 (ADR-M49): at G8 the workflow builds the release pack (`buildReleasePack`), Person B
//   approves the release, the pack is sealed and the intent ends `done`; the history replays.
// The runner here is a fake activity worker; the real push is tested in `publish-run.test.ts`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TestWorkflowEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode, Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createIntentActivities,
  type IntentActivityDeps,
} from '../../../apps/worker/src/activities/intent-activities.js';
import { startIntentWorker, type IntentWorkerHandle } from '../../../apps/worker/src/temporal.js';
import type { PullRequestInfo, ReviewDecision } from '../../../packages/contracts/src/git-host.js';
import {
  intentWorkflowId,
  type IntentWorkflowRef,
} from '../../../packages/contracts/src/intent-workflow.js';
import {
  RUNNER_TASK_QUEUE,
  type ExecuteRunInput,
  type ExecuteRunResult,
  type PublishRunInput,
  type PublishRunResult,
} from '../../../packages/contracts/src/run-activity.js';
import { decideGate } from '../../../packages/core/src/commands/gate-command.js';
import type { Intent } from '../../../packages/core/src/db/schema.js';
import type { PublishDeps } from '../../../packages/core/src/workflow/publish.js';
import { TemporalIntentSignals } from '../../../packages/workflow-client/src/index.js';
import { createTestDatabase, describeDb, type TestDatabase } from '../db/helpers.js';
import { MemoryEvidenceStore } from '../db/memory-evidence-store.js';
import { atG4, harness, Secret, T0, type Harness } from '../g4-harness.js';
import { PEOPLE } from './fixture.js';

const testServer = process.env.SDLC_TEMPORAL_TEST_SERVER;
if (!testServer && process.env.SDLC_REQUIRE_DB === '1' && process.env.SDLC_WORKFLOW_TEST === '1') {
  throw new Error('SDLC_TEMPORAL_TEST_SERVER is not set (run: pnpm test:workflow)');
}
const describeWorkflow = testServer ? describeDb : describe.skip;

const WORKFLOWS = path.resolve(__dirname, '../../../apps/worker/dist/workflows/index.js');
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const HEAD = 'e'.repeat(40);

async function waitFor<T>(read: () => Promise<T>, ok: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out; last value ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

type PushMode = 'push' | 'fail' | 'lost';

describeWorkflow(
  'C08 PR 1: the push and the pull request on Temporal',
  () => {
    let db: TestDatabase;
    let t: Harness;
    let env: TestWorkflowEnvironment;
    const evidence = new MemoryEvidenceStore();
    let bundlePath: string;
    let signals: TemporalIntentSignals;
    let intentWorker: IntentWorkerHandle | undefined;
    let runnerWorker: Worker | undefined;
    let runnerRunning: Promise<void> | undefined;
    let pushMode: PushMode = 'push';
    let prCounter = 100;
    const pushTokens: string[] = [];
    /** E01: what GitHub says about CI, the reviews and the merge (CI pending by default). */
    const gh = {
      ciPassed: false,
      reviews: [] as ReviewDecision[],
      merged: false,
    };

    /** The fake runner's run: always succeeds in scope (C07 records). */
    async function executeRun(input: ExecuteRunInput): Promise<ExecuteRunResult> {
      const scope = t.f.scope;
      const now = new Date();
      await scope.runs.claimForProvisioning(input.runId, now);
      await scope.runs.transition(input.runId, { from: ['provisioning'], to: 'running', now });
      await scope.runEvents.append(input.runId, 'diff_stored', {
        sha256: 'd'.repeat(64),
        size_bytes: 64,
        changed_files: 1,
      });
      await scope.runEvents.append(input.runId, 'changes_checked', {
        changed_files: 1,
        out_of_scope: 0,
        instruction_files: 0,
        paths_sha256: 'a'.repeat(64),
      });
      await scope.runs.transition(input.runId, {
        from: ['running'],
        to: 'succeeded',
        now: new Date(),
        finishedAt: new Date(),
      });
      return { outcome: 'ended', status: 'succeeded', stopReason: null };
    }

    /** The fake runner's push: records what `publishRun` records, by mode. */
    async function publishRun(input: PublishRunInput): Promise<PublishRunResult> {
      pushTokens.push(input.wrappedPushToken);
      const scope = t.f.scope;
      if (pushMode === 'lost') {
        // The activity fails without an answer (the runner stopped, a heartbeat timeout): the
        // workflow sees an activity failure either way.
        throw new Error('runner lost');
      }
      if (pushMode === 'fail') {
        await scope.runEvents.append(input.runId, 'publish_failed', { reason: 'push_rejected' });
        return { outcome: 'failed', reason: 'push_rejected' };
      }
      const run = await scope.runs.getById(input.runId);
      await scope.transaction(async (tx) => {
        await tx.runEvents.append(input.runId, 'branch_pushed', {
          head_sha: HEAD,
          parent_sha: run!.base_sha,
          diff_sha256: 'd'.repeat(64),
          paths_sha256: 'a'.repeat(64),
        });
        await tx.runs.recordPushedHead(input.runId, HEAD, new Date());
      });
      return { outcome: 'pushed' };
    }

    const pr = (number: number): PullRequestInfo => ({
      number,
      state: gh.merged ? 'closed' : 'open',
      draft: false,
      merged: gh.merged,
      mergedAt: gh.merged ? new Date(Date.now() + 365 * DAY).toISOString() : null,
      mergeCommitSha: gh.merged ? 'a'.repeat(40) : null,
      headSha: HEAD,
      headRef: 'agent/INT-x',
      baseRef: 'main',
      author: { id: '1', login: 'sdlc[bot]', type: 'bot' },
      mergedBy: gh.merged ? { id: String(PEOPLE.b.gh), login: PEOPLE.b.login, type: 'user' } : null,
      changedFiles: 1,
      url: `https://github.com/acme/shop/pull/${String(number)}`,
    });

    const publish = (): PublishDeps => ({
      registry: t.f.registry,
      gitHost: {
        issueShortLivedToken: (repo, scope) =>
          Promise.resolve({
            token: new Secret('ghs_push_token_canary'),
            expiresAt: T0.toISOString(),
            repo,
            permissions: scope.permissions,
          }),
        findOpenPullRequest: () => Promise.resolve(null),
        openPullRequest: () => {
          prCounter += 1;
          return Promise.resolve(pr(prCounter));
        },
      },
      wrapper: {
        wrap: () => Promise.resolve(new Secret(`push-wrap-${String(pushTokens.length)}`)),
      },
    });

    const ref = (intent: Intent): IntentWorkflowRef => ({
      tenantId: t.f.target.tenantId,
      intentId: intent.id,
    });
    const reload = async (intent: Intent) => (await t.f.scope.intents.getById(intent.id))!;
    const until = (intent: Intent, check: (i: Intent) => boolean) =>
      waitFor(() => reload(intent), check);
    const publishEvents = async (intent: Intent) => {
      const [run] = await t.f.scope.runs.listForIntent(intent.id);
      return (await t.f.scope.runEvents.list(run!.id))
        .filter((e) => ['branch_pushed', 'publish_failed'].includes(e.event_type))
        .map((e) => [e.event_type, (e.payload as { reason?: string }).reason ?? null]);
    };

    /** A Medium intent at G6, its G5 block window closed (the registry's clock moves on). */
    async function atG6(): Promise<Intent> {
      t.setClock(T0);
      const intent = await atG4(t, 'medium');
      await signals.wake(ref(intent));
      await until(intent, (i) => i.status === 'in_gate' && i.current_gate === 'G6');
      t.setClock(new Date(T0.getTime() + 3 * DAY));
      return intent;
    }

    beforeAll(async () => {
      db = await createTestDatabase();
      t = await harness(db);
      env = await TestWorkflowEnvironment.createTimeSkipping({
        server: { executable: { type: 'existing-path', path: testServer! } },
      });
      const { code } = await bundleWorkflowCode({ workflowsPath: WORKFLOWS });
      bundlePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-pub-')), 'bundle.js');
      fs.writeFileSync(bundlePath, code);
      signals = new TemporalIntentSignals(env.client);
      intentWorker = await startIntentWorker({
        settings: { address: env.address, namespace: env.namespace ?? 'default' },
        workflowBundlePath: bundlePath,
        activities: createIntentActivities({
          db: db.app as unknown as IntentActivityDeps['db'],
          registry: t.f.registry as unknown as IntentActivityDeps['registry'],
          g4: t.g4,
          runs: t.runDeps as unknown as IntentActivityDeps['runs'],
          publish: publish() as unknown as IntentActivityDeps['publish'],
          g6: {
            gitHost: {
              getPullRequest: (_ref, number) => Promise.resolve(pr(number)),
              getCheckStatus: (_ref, sha) =>
                Promise.resolve({
                  sha,
                  state: gh.ciPassed ? 'success' : 'pending',
                  checks: [
                    {
                      source: 'check_run',
                      id: '1',
                      name: 'ci-ok',
                      completed: gh.ciPassed,
                      conclusion: gh.ciPassed ? 'success' : null,
                    },
                  ],
                }),
              getSecurityFindings: () =>
                Promise.resolve({
                  known: true,
                  counts: { critical: 0, high: 0, medium: 0, low: 0 },
                }),
            },
          },
          g7: {
            gitHost: {
              getPullRequest: (_ref, number) => Promise.resolve(pr(number)),
              getReviews: () => Promise.resolve([...gh.reviews]),
              getCommitAuthors: () => Promise.resolve({ accounts: [], withoutAccount: 1 }),
            },
          },
          // E03: the worker's evidence store for G8's release pack.
          releases: { store: evidence, maxItemBytes: 1024 * 1024 },
        }),
      });
      runnerWorker = await Worker.create({
        connection: env.nativeConnection,
        namespace: env.namespace ?? 'default',
        taskQueue: RUNNER_TASK_QUEUE,
        activities: { executeRun, publishRun },
        maxConcurrentActivityTaskExecutions: 1,
      });
      runnerRunning = runnerWorker.run();
    }, 120_000);

    afterAll(async () => {
      runnerWorker?.shutdown();
      await runnerRunning?.catch(() => undefined);
      await intentWorker?.shutdown();
      await env?.teardown();
      await t?.f.close();
      await db?.drop();
    }, 60_000);

    it('G5 → the block window → push → pull request → waits for CI; no token in the history', async () => {
      pushMode = 'push';
      const intent = await atG6();
      // The registry clock moved past the block window: a wake lets G6 act.
      await signals.wake(ref(intent));
      const linked = await until(intent, (i) => i.pr_number !== null);
      expect(linked).toMatchObject({ status: 'in_gate', current_gate: 'G6' });
      expect(await publishEvents(intent)).toEqual([['branch_pushed', null]]);
      const kinds = (await t.f.scope.intentNotices.listForIntent(intent.id)).map((n) => n.kind);
      expect(kinds.at(-1)).toBe('pr_opened');

      const history = await env.client.workflow
        .getHandle(intentWorkflowId(ref(intent)))
        .fetchHistory();
      const text = JSON.stringify(history, (key, value: unknown) => {
        if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
        return key === 'data' && typeof value === 'string'
          ? Buffer.from(value, 'base64').toString('utf8')
          : value;
      });
      expect(text).toContain('push-wrap-'); // the single-use wrapping token, by design
      expect(text).not.toContain('ghs_push_token_canary');
      await expect(
        Worker.runReplayHistory({ workflowBundle: { codePath: bundlePath } }, history),
      ).resolves.toBeUndefined();
    });

    it('a lost runner during the push counts as a failed attempt; the next one pushes', async () => {
      pushMode = 'lost';
      const intent = await atG6();
      const before = pushTokens.length;
      await signals.wake(ref(intent));
      await waitFor(
        () => Promise.resolve(pushTokens.length),
        (n) => n > before,
      );
      pushMode = 'push';
      // The workflow waits a minute after the lost attempt, then tries again.
      for (let i = 0; i < 10 && (await reload(intent)).pr_number === null; i += 1) {
        await env.sleep(2 * MINUTE);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      await until(intent, (i) => i.pr_number !== null);
      expect(await publishEvents(intent)).toEqual([
        ['publish_failed', 'runner_lost'],
        ['branch_pushed', null],
      ]);
    });

    it('repeated failures stop the push: paused at G6, a technical escalation (QUESTIONS #156)', async () => {
      pushMode = 'fail';
      const intent = await atG6();
      await signals.wake(ref(intent));
      // The workflow waits a minute between attempts: let the test server's clock run.
      for (let i = 0; i < 3; i += 1) {
        await waitFor(
          async () => (await publishEvents(intent)).length,
          (n) => n > i,
        );
        await env.sleep(2 * MINUTE);
      }
      await until(intent, (i) => i.status === 'paused' && i.current_gate === 'G6');
      expect(await publishEvents(intent)).toEqual([
        ['publish_failed', 'push_rejected'],
        ['publish_failed', 'push_rejected'],
        ['publish_failed', 'push_rejected'],
      ]);
      const [escalation] = await t.f.scope.escalations.listForIntent(intent.id);
      expect(escalation).toMatchObject({
        route: 'technical',
        response_level: 'pause',
        packet: { gate: 'G6', subject_kind: 'diff' },
      });
      pushMode = 'push';
    });

    it('E01: CI passes → G7; a review of the pushed commit and a merge by Person B → G8', async () => {
      pushMode = 'push';
      const intent = await atG6();
      await signals.wake(ref(intent));
      await until(intent, (i) => i.pr_number !== null);
      gh.ciPassed = true;
      await signals.wake(ref(intent));
      await until(intent, (i) => i.current_gate === 'G7');
      t.setClock(new Date(T0.getTime() + 6 * DAY)); // past the G6 block window
      gh.reviews = [
        {
          eventId: 'github:review:9001',
          reviewId: '9001',
          reviewer: { id: String(PEOPLE.b.gh), login: PEOPLE.b.login, type: 'user' },
          state: 'approved',
          commitSha: HEAD,
          submittedAt: new Date(Date.now() - DAY).toISOString(),
          url: 'https://github.com/acme/shop/pull/1#pullrequestreview-9001',
        },
      ];
      await signals.wake(ref(intent));
      await waitFor(
        async () => (await t.f.scope.intentNotices.listForIntent(intent.id)).map((n) => n.kind),
        (kinds) => kinds.includes('g7_merge_ready'),
      );
      gh.merged = true;
      await signals.wake(ref(intent));
      const merged = await until(intent, (i) => i.current_gate === 'G8');
      expect(merged).toMatchObject({ status: 'in_gate', current_gate: 'G8' });
      // E03: the workflow builds the release pack; Person B approves; sealed; done.
      await waitFor(
        () => t.f.scope.evidencePacks.listForIntent(intent.id),
        (packs) => packs.length > 0,
      );
      await decideGate(t.f.registry, t.f.scope, {
        intent: await t.reload(intent),
        gate: 'G8',
        decision: 'approve',
        actorId: t.f.users.b,
        source: 'cli',
      });
      await signals.wake(ref(intent));
      const done = await until(intent, (i) => i.status === 'done');
      expect(done).toMatchObject({ status: 'done', current_gate: 'G8' });
      const sealed = (await t.f.scope.evidencePacks.listForIntent(intent.id)).filter(
        (p) => p.sealed_at !== null,
      );
      expect(sealed).toHaveLength(1);
      expect(evidence.puts).toBeGreaterThanOrEqual(4); // two versions: before and after the approval
      const history = await env.client.workflow
        .getHandle(intentWorkflowId(ref(intent)))
        .fetchHistory();
      await expect(
        Worker.runReplayHistory({ workflowBundle: { codePath: bundlePath } }, history),
      ).resolves.toBeUndefined();
      gh.ciPassed = false;
      gh.merged = false;
      gh.reviews = [];
    });
  },
  120_000,
);
