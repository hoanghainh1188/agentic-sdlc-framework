// D-08 E01 AC4 on Temporal (design/ADR-M41 §2.7, QUESTIONS #179): the time-skipping test server
// with a throw-away PostgreSQL. Run with `pnpm test:workflow`.
//
// G7 → Person B requests changes with a review → G4 → `prepareRun` (a third wrapping token) →
// `executeRun` on the task queue `sdlc-runner` → the runner's real feedback read
// (`loadAgentTask` → `readRunFeedback`, with a fake token-only Git host) → the agent's first
// message (`buildTaskMessage`) holds the feedback inside the nonce block → the run pushes → G7.
// - the runner reads only the recorded review by its ID, never a later decoy review;
// - the feedback text (a marker) is in the agent's message only: never in the Temporal history,
//   any table (run_events, audit_log, intent_notices, git_event_receipts, …) or the process output
//   (stdout and stderr, where the platform's logs go);
// - the history holds the feedback token's wrapping token, never the token, and replays.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TestWorkflowEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode, Worker } from '@temporalio/worker';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { loadAgentTask } from '../../../apps/runner/src/index.js';
import {
  createIntentActivities,
  type IntentActivityDeps,
} from '../../../apps/worker/src/activities/intent-activities.js';
import { startIntentWorker, type IntentWorkerHandle } from '../../../apps/worker/src/temporal.js';
import { buildTaskMessage } from '../../../packages/adapters/agent-openhands/src/index.js';
import type {
  PullRequestInfo,
  RedactedSecret,
  RepoRef,
  ReviewDecision,
  RunContract,
} from '../../../packages/contracts/src/index.js';
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
import type { Intent } from '../../../packages/core/src/db/schema.js';
import type { PublishDeps } from '../../../packages/core/src/workflow/publish.js';
import { TemporalIntentSignals } from '../../../packages/workflow-client/src/index.js';
import { createTestDatabase, describeDb, type TestDatabase } from '../db/helpers.js';
import { atG4, harness, Secret, T0, type Harness } from '../g4-harness.js';
import { PEOPLE } from './fixture.js';

const testServer = process.env.SDLC_TEMPORAL_TEST_SERVER;
if (!testServer && process.env.SDLC_REQUIRE_DB === '1' && process.env.SDLC_WORKFLOW_TEST === '1') {
  throw new Error('SDLC_TEMPORAL_TEST_SERVER is not set (run: pnpm test:workflow)');
}
const describeWorkflow = testServer ? describeDb : describe.skip;

const WORKFLOWS = path.resolve(__dirname, '../../../apps/worker/dist/workflows/index.js');
const DAY = 24 * 60 * 60_000;
const HEADS = ['e'.repeat(40), 'c'.repeat(40)];
const MARKER = 'FEEDBACK-MARKER-wf-93b1';
const STRANGER = { gh: 9001, login: 'stranger' };

async function waitFor<T>(read: () => Promise<T>, ok: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out; last value ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describeWorkflow(
  'E01 PR 2: a request for changes at G7 starts a new run, on Temporal',
  () => {
    let db: TestDatabase;
    let t: Harness;
    let env: TestWorkflowEnvironment;
    let bundlePath: string;
    let signals: TemporalIntentSignals;
    let intentWorker: IntentWorkerHandle | undefined;
    let runnerWorker: Worker | undefined;
    let runnerRunning: Promise<void> | undefined;
    let pushes = 0;
    let prCounter = 400;
    /** The agent's first messages, one per run (what reaches the sandbox). */
    const messages: string[] = [];
    /** Every call of the runner's fake token-only Git host. */
    const readerCalls: string[] = [];
    const feedbackTokens: (string | undefined)[] = [];
    /** Everything written to stdout and stderr while the workflow runs. */
    let output = '';
    const gh = { ciPassed: true, reviews: [] as ReviewDecision[] };

    const reader = {
      getReviewFeedback: (_t: RedactedSecret, _r: RepoRef, pr: number, id: string) => {
        readerCalls.push(`review:${String(pr)}:${id}`);
        return Promise.resolve({
          reviewId: id,
          reviewer: { id: String(PEOPLE.b.gh), login: PEOPLE.b.login, type: 'user' as const },
          state: 'changes_requested' as const,
          commitSha: HEADS[0]!,
          body: `${MARKER}: round the tax down per rate.`,
          comments: [],
          commentsTruncated: false,
        });
      },
      getIssueComment: () => Promise.reject(new Error('no comment in this test')),
      revokeShortLivedToken: () => {
        readerCalls.push('revoke');
        return Promise.resolve();
      },
    };

    /** The fake runner: the real task load (with the feedback read), then a run in scope. */
    async function executeRun(input: ExecuteRunInput): Promise<ExecuteRunResult> {
      feedbackTokens.push(input.wrappedFeedbackToken);
      const scope = t.f.scope;
      const now = new Date();
      await scope.runs.claimForProvisioning(input.runId, now);
      await scope.runs.transition(input.runId, { from: ['provisioning'], to: 'running', now });
      const contract = (await scope.runContracts.getByRunId(input.runId))!
        .contract_json as unknown as RunContract;
      const task = await loadAgentTask(
        scope as unknown as Parameters<typeof loadAgentTask>[0],
        contract,
        {
          reader,
          unwrapper: { unwrap: () => Promise.resolve({ token: new Secret('ghs_fb') }) },
          ...(input.wrappedFeedbackToken
            ? { wrappedToken: new Secret(input.wrappedFeedbackToken) }
            : {}),
        },
      );
      messages.push(buildTaskMessage(contract, task, '/workspace'));
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

    async function publishRun(input: PublishRunInput): Promise<PublishRunResult> {
      const scope = t.f.scope;
      const run = await scope.runs.getById(input.runId);
      const head = HEADS[Math.min(pushes, HEADS.length - 1)]!;
      pushes += 1;
      await scope.transaction(async (tx) => {
        await tx.runEvents.append(input.runId, 'branch_pushed', {
          head_sha: head,
          parent_sha: run!.base_sha,
          diff_sha256: 'd'.repeat(64),
          paths_sha256: 'a'.repeat(64),
        });
        await tx.runs.recordPushedHead(input.runId, head, new Date());
      });
      return { outcome: 'pushed' };
    }

    const pr = (number: number): PullRequestInfo => ({
      number,
      state: 'open',
      draft: false,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headSha: HEADS[Math.max(0, Math.min(pushes - 1, HEADS.length - 1))]!,
      headRef: 'agent/INT-x',
      baseRef: 'main',
      author: { id: '1', login: 'sdlc[bot]', type: 'bot' },
      mergedBy: null,
      changedFiles: 1,
      url: `https://github.com/acme/shop/pull/${String(number)}`,
    });

    const publish = (): PublishDeps => ({
      registry: t.f.registry,
      gitHost: {
        issueShortLivedToken: (repo, scope) =>
          Promise.resolve({
            token: new Secret('ghs_push'),
            expiresAt: T0.toISOString(),
            repo,
            permissions: scope.permissions,
          }),
        findOpenPullRequest: () => Promise.resolve(prCounter > 400 ? pr(prCounter) : null),
        openPullRequest: () => {
          prCounter += 1;
          return Promise.resolve(pr(prCounter));
        },
      },
      wrapper: { wrap: () => Promise.resolve(new Secret('push-wrap')) },
    });

    const ref = (intent: Intent): IntentWorkflowRef => ({
      tenantId: t.f.target.tenantId,
      intentId: intent.id,
    });
    const reload = async (intent: Intent) => (await t.f.scope.intents.getById(intent.id))!;
    const until = (intent: Intent, check: (i: Intent) => boolean) =>
      waitFor(() => reload(intent), check);

    async function tablesContaining(needle: string): Promise<string[]> {
      const tables = await sql<{ table_name: string }>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`.execute(db.owner);
      const found: string[] = [];
      for (const { table_name: name } of tables.rows) {
        if (!/^[a-z_0-9]+$/.test(name)) throw new Error(`unexpected table ${name}`);
        const hit = await sql<{ n: number }>`
          SELECT count(*)::int AS n FROM ${sql.table(name)} AS r
          WHERE r::text LIKE ${`%${needle}%`}`.execute(db.owner);
        if ((hit.rows[0]?.n ?? 0) > 0) found.push(name);
      }
      return found;
    }

    beforeAll(async () => {
      db = await createTestDatabase();
      t = await harness(db);
      env = await TestWorkflowEnvironment.createTimeSkipping({
        server: { executable: { type: 'existing-path', path: testServer! } },
      });
      const { code } = await bundleWorkflowCode({ workflowsPath: WORKFLOWS });
      bundlePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-rc-')), 'bundle.js');
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
                  state: 'success',
                  checks: [
                    {
                      source: 'check_run',
                      id: '1',
                      name: 'ci-ok',
                      completed: true,
                      conclusion: 'success',
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

    it('a review requesting changes → a new run whose agent gets the feedback; no text anywhere else', async () => {
      // Captures what the processes print (the platform's JSON logs go to stdout and stderr).
      const spies = [process.stdout, process.stderr].map((stream) =>
        vi.spyOn(stream, 'write').mockImplementation((chunk: string | Uint8Array) => {
          output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
          return true;
        }),
      );
      try {
        t.setClock(T0);
        const intent = await atG4(t, 'medium');
        await signals.wake(ref(intent));
        await until(intent, (i) => i.status === 'in_gate' && i.current_gate === 'G6');
        t.setClock(new Date(T0.getTime() + 3 * DAY)); // past the G5 block window
        await signals.wake(ref(intent));
        await until(intent, (i) => i.current_gate === 'G7');
        t.setClock(new Date(T0.getTime() + 6 * DAY)); // past the G6 block window
        const fromB: ReviewDecision = {
          eventId: 'github:review:7101',
          reviewId: '7101',
          reviewer: { id: String(PEOPLE.b.gh), login: PEOPLE.b.login, type: 'user' },
          state: 'changes_requested',
          commitSha: HEADS[0]!,
          submittedAt: new Date(Date.now() - DAY).toISOString(),
          url: 'https://github.com/acme/shop/pull/1#pullrequestreview-7101',
        };
        // A later decoy by a stranger: anyone can review a public repository.
        const decoy: ReviewDecision = {
          ...fromB,
          eventId: 'github:review:7102',
          reviewId: '7102',
          reviewer: { id: String(STRANGER.gh), login: STRANGER.login, type: 'user' },
          url: 'https://github.com/acme/shop/pull/1#pullrequestreview-7102',
        };
        gh.reviews = [fromB, decoy];
        t.calls.reviews = gh.reviews;
        await signals.wake(ref(intent));
        // G7 → G4 → the second run → pushed → back at G7 on the new head.
        await waitFor(
          () => Promise.resolve(messages.length),
          (n) => n >= 2,
        );
        await until(intent, (i) => i.status === 'in_gate' && i.current_gate === 'G6');
        t.setClock(new Date(T0.getTime() + 9 * DAY)); // past the second run's G5 block window
        await signals.wake(ref(intent));
        await until(intent, (i) => i.current_gate === 'G7' && i.status === 'in_gate');

        expect(feedbackTokens[0]).toBeUndefined(); // the first run answers no request
        expect(feedbackTokens[1]).toBe('wrap-token'); // the second: its wrapping token only
        expect(readerCalls).toEqual([`review:${String(prCounter)}:7101`, 'revoke']);
        expect(messages[0]).not.toContain(MARKER);
        const message = messages[1]!;
        const nonce = /<<<REVIEWER_FEEDBACK ([0-9a-f]+)>>>/.exec(message)?.[1];
        expect(nonce).toBeDefined();
        const block = message.slice(
          message.indexOf(`<<<REVIEWER_FEEDBACK ${nonce!}>>>`),
          message.indexOf(`<<<END_REVIEWER_FEEDBACK ${nonce!}>>>`),
        );
        expect(block).toContain(MARKER);
        expect(message).toContain('untrusted data written by a person');

        const history = await env.client.workflow
          .getHandle(intentWorkflowId(ref(intent)))
          .fetchHistory();
        const text = JSON.stringify(history, (key, value: unknown) => {
          if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
          return key === 'data' && typeof value === 'string'
            ? Buffer.from(value, 'base64').toString('utf8')
            : value;
        });
        expect(text).toContain('wrappedFeedbackToken');
        expect(text).not.toContain(MARKER);
        expect(text).not.toContain('ghs_fb');
        expect(await tablesContaining(MARKER)).toEqual([]);
        expect(output).not.toContain(MARKER);
        await expect(
          Worker.runReplayHistory({ workflowBundle: { codePath: bundlePath } }, history),
        ).resolves.toBeUndefined();
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    });
  },
  120_000,
);
