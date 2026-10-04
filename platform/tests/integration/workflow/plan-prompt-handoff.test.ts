// B09 PR 2 on Temporal (design/ADR-M40 §2.7, QUESTIONS #169): the time-skipping test server with a
// throw-away PostgreSQL. Run with `pnpm test:workflow`.
//
// A plan read from a file → G3 → G4 → `executeRun` on the task queue `sdlc-runner` → the runner's
// real task load (`loadAgentTask` → `planFileReader`, a real local Git repository as its clone) →
// the agent's first message (`buildTaskMessage`) holds the plan's task text inside the nonce
// block. The plan text (a marker) is in the agent's message only: never in the Temporal history,
// any table (run_events, audit_log, plans, …) or the process output (stdout and stderr, where the
// platform's logs go). The history replays.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TestWorkflowEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode, Worker } from '@temporalio/worker';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { loadAgentTask, planFileReader } from '../../../apps/runner/src/index.js';
import {
  createIntentActivities,
  type IntentActivityDeps,
} from '../../../apps/worker/src/activities/intent-activities.js';
import { startIntentWorker, type IntentWorkerHandle } from '../../../apps/worker/src/temporal.js';
import { buildTaskMessage } from '../../../packages/adapters/agent-openhands/src/index.js';
import type { RunContract } from '../../../packages/contracts/src/index.js';
import {
  intentWorkflowId,
  type IntentWorkflowRef,
} from '../../../packages/contracts/src/intent-workflow.js';
import {
  RUNNER_TASK_QUEUE,
  type ExecuteRunInput,
  type ExecuteRunResult,
} from '../../../packages/contracts/src/run-activity.js';
import type { Intent } from '../../../packages/core/src/db/schema.js';
import { planPath } from '../../../packages/core/src/plans/index.js';
import { TemporalIntentSignals } from '../../../packages/workflow-client/src/index.js';
import { createTestDatabase, describeDb, type TestDatabase } from '../db/helpers.js';
import { approve, decideAt, harness, T0, type Harness } from '../g4-harness.js';

const testServer = process.env.SDLC_TEMPORAL_TEST_SERVER;
if (!testServer && process.env.SDLC_REQUIRE_DB === '1' && process.env.SDLC_WORKFLOW_TEST === '1') {
  throw new Error('SDLC_TEMPORAL_TEST_SERVER is not set (run: pnpm test:workflow)');
}
const describeWorkflow = testServer ? describeDb : describe.skip;

const WORKFLOWS = path.resolve(__dirname, '../../../apps/worker/dist/workflows/index.js');
const MARKER = 'PLAN-MARKER-wf-7d41';

async function waitFor<T>(read: () => Promise<T>, ok: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out; last value ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function planYaml(code: string): string {
  return [
    'plan:',
    `  intent_id: ${code}`,
    'tasks:',
    '  - id: T1',
    `    summary: ${MARKER} cancel an order and return the stock`,
    '    allowed_paths: [apps/api/src/orders/**]',
    '    tools: [file_editor, terminal]',
    `    definition_of_done: [${MARKER} AC1 has a passing test]`,
    '',
  ].join('\n');
}

/** The runner's clone (`<clone>/repo`, `<clone>/home`) with one commit holding `files`. */
function cloneWith(root: string, files: Record<string, string>): { dir: string; commit: string } {
  const dir = fs.mkdtempSync(path.join(root, 'clone-'));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(dir, 'home'));
  fs.mkdirSync(repo);
  const git = (args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], {
      env: {
        PATH: process.env.PATH,
        HOME: path.join(dir, 'home'),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.invalid',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.invalid',
      },
    })
      .toString()
      .trim();
  git(['init', '-q']);
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), text);
  }
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'plan']);
  return { dir, commit: git(['rev-parse', 'HEAD']) };
}

describeWorkflow(
  'B09 PR 2: the runner reads the plan file for the prompt, on Temporal',
  () => {
    let db: TestDatabase;
    let t: Harness;
    let env: TestWorkflowEnvironment;
    let bundlePath: string;
    let signals: TemporalIntentSignals;
    let intentWorker: IntentWorkerHandle | undefined;
    let runnerWorker: Worker | undefined;
    let runnerRunning: Promise<void> | undefined;
    let root: string;
    let cloneDir = '';
    /** The agent's first messages, one per run (what reaches the sandbox). */
    const messages: string[] = [];
    /** Everything written to stdout and stderr while the workflow runs. */
    let output = '';

    /** The fake runner: the real task load from the clone, then a run in scope. */
    async function executeRun(input: ExecuteRunInput): Promise<ExecuteRunResult> {
      const scope = t.f.scope;
      const now = new Date();
      await scope.runs.claimForProvisioning(input.runId, now);
      await scope.runs.transition(input.runId, { from: ['provisioning'], to: 'running', now });
      const contract = (await scope.runContracts.getByRunId(input.runId))!
        .contract_json as unknown as RunContract;
      const task = await loadAgentTask(
        scope as unknown as Parameters<typeof loadAgentTask>[0],
        contract,
        {},
        planFileReader(cloneDir, 10_000),
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

    const ref = (intent: Intent): IntentWorkflowRef => ({
      tenantId: t.f.target.tenantId,
      intentId: intent.id,
    });
    const reload = async (intent: Intent) => (await t.f.scope.intents.getById(intent.id))!;

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

    /** A Medium intent whose plan was read from a file, approved at G3 (the next step: G4). */
    async function atG4WithPlanFile(): Promise<Intent> {
      const intent = await t.f.newIntent({ riskTier: 'medium' });
      await t.settle(intent);
      await decideAt(t, intent, 'G1', 'a');
      const text = planYaml(intent.code);
      const clone = cloneWith(root, { [planPath(intent.code)]: text });
      cloneDir = clone.dir;
      await t.f.registry.linkSpec(t.f.scope, intent.id, {
        path: 'docs/specs/t07.md',
        commitSha: clone.commit,
        contentSha256: '5'.repeat(64),
        actorType: 'human',
        actorId: t.f.users.a,
      });
      await t.f.registry.submitPlan(t.f.scope, intent.id, {
        plannedFiles: ['apps/api/src/orders/**'],
        planSha256: createHash('sha256').update(text, 'utf8').digest('hex'),
        actorType: 'human',
        actorId: t.f.users.a,
        file: { commitSha: clone.commit, allowedTools: ['file_editor', 'terminal'] },
      });
      await t.settle(intent);
      await decideAt(t, intent, 'G2', 'a');
      await approve(t, intent, 'G3', 'b');
      return intent;
    }

    beforeAll(async () => {
      db = await createTestDatabase();
      t = await harness(db);
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-plan-wf-'));
      env = await TestWorkflowEnvironment.createTimeSkipping({
        server: { executable: { type: 'existing-path', path: testServer! } },
      });
      const { code } = await bundleWorkflowCode({ workflowsPath: WORKFLOWS });
      bundlePath = path.join(root, 'bundle.js');
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
        }),
      });
      runnerWorker = await Worker.create({
        connection: env.nativeConnection,
        namespace: env.namespace ?? 'default',
        taskQueue: RUNNER_TASK_QUEUE,
        activities: { executeRun },
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
      if (root) fs.rmSync(root, { recursive: true, force: true });
    }, 60_000);

    it('the plan text reaches the agent inside its block; nowhere else', async () => {
      // Captures what the processes print (the platform's JSON logs go to stdout and stderr).
      const spies = [process.stdout, process.stderr].map((stream) =>
        vi.spyOn(stream, 'write').mockImplementation((chunk: string | Uint8Array) => {
          output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
          return true;
        }),
      );
      try {
        t.setClock(T0);
        const intent = await atG4WithPlanFile();
        await signals.wake(ref(intent));
        await waitFor(
          () => Promise.resolve(messages.length),
          (n) => n >= 1,
        );
        // The run ended and the workflow moved on (G5 passed; G6 waits for the block window).
        await waitFor(
          () => reload(intent),
          (i) => i.current_gate === 'G6',
        );

        const message = messages[0]!;
        const nonce = /<<<PLAN_TASKS ([0-9a-f]+)>>>/.exec(message)?.[1];
        expect(nonce).toBeDefined();
        const block = message.slice(
          message.indexOf(`<<<PLAN_TASKS ${nonce!}>>>`),
          message.indexOf(`<<<END_PLAN_TASKS ${nonce!}>>>`),
        );
        expect(block).toContain(`summary: ${MARKER} cancel an order`);
        expect(block).toContain(`- ${MARKER} AC1 has a passing test`);
        expect(message).not.toContain('(no summary)');

        const runs = await t.f.scope.runs.listForIntent(intent.id);
        const events = await t.f.scope.runEvents.list(runs[0]!.id);
        expect(events.map((e) => e.event_type)).toContain('plan_read');

        const history = await env.client.workflow
          .getHandle(intentWorkflowId(ref(intent)))
          .fetchHistory();
        const text = JSON.stringify(history, (key, value: unknown) => {
          if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
          return key === 'data' && typeof value === 'string'
            ? Buffer.from(value, 'base64').toString('utf8')
            : value;
        });
        expect(text).not.toContain(MARKER);
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
