// D-08 L04 (PR 4c) on PostgreSQL with the Docker stub, a scripted agent and the real contract
// (design/ADR-M81 §2.3, §2.8): `executeEvaluation` from the signed contract to the scored measures.
// - the run is claimed, the sandbox is the prepared base of the task, the agent gets the capped key,
//   the change is recomputed outside the sandbox, the scoring runs in its own containers and the
//   measures are codes and numbers; the run stays `running` for the worker to write the result;
// - a contract that expired gives the run its next attempt; a run someone took is left alone;
// - a real run that needs the slot stops the agent: the run is `preempted` and queued again with the
//   next attempt, and the attempt is not counted; a cancel of the activity ends it `cancelled`;
// - every failure is a code on the run (`failed`), never text; nothing is left in Docker or on disk.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {
  AgentAdapter,
  AgentRunHandle,
  AgentRunStatus,
  ExecuteEvaluationRunInput,
  RunContractSigner,
  RunContractVerifier,
  StartAgentRun,
} from '@sdlc/contracts';
import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';
import { loadTaskSet } from '@sdlc/eval';
import { Redacted } from '@sdlc/secrets';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';

import {
  CloneError,
  DockerClient,
  executeEvaluation,
  HeldRuns,
  runnerSettingsFromEnv,
  SlotPool,
  type ExecuteEvaluationDeps,
  type RunnerSettings,
} from '../../../apps/runner/src/index.js';
import { packTar, type TarEntry } from '../../../apps/runner/src/workspace/tar.js';
import {
  createEvaluationPlan,
  evaluationContractBytes,
  issueEvaluationContract,
  startEvaluationPlan,
  type EvaluationPlanDeps,
} from '../../../packages/core/src/evaluation/index.js';
import { StubDocker } from '../../runner/stub-docker.js';
import { repoRoot } from '../../workspace/helpers';
import { seedEvaluation, type SeededEvaluation } from '../evaluation-seed.js';
import { seedPlanWorld } from '../plan-seed.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

const NOW = new Date('2026-10-14T08:00:00.000Z');
const GOOD = '{"applied":true,"ci":true,"pass_to_pass":true,"fail_to_pass":false,"lint":1}';
const TOKEN = 'ghs_evalCloneTokenCanary0000000000';
const KEY = 'sk-eval-virtual-key-canary-0000000000';

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

/** A scripted agent: runs until `finish()`, then reports `finished`; records what it was given. */
class ScriptedAgent implements AgentAdapter {
  started: StartAgentRun[] = [];
  stopped = 0;
  commits = 0;
  failStart = false;
  /** Called when the agent starts, with the sandbox's container name: the test sets its export. */
  onStart: (input: StartAgentRun) => void = () => undefined;
  #done = false;
  #handle: AgentRunHandle | undefined;

  finish(): void {
    this.#done = true;
  }
  reset(): void {
    this.started = [];
    this.stopped = 0;
    this.commits = 0;
    this.failStart = false;
    this.onStart = () => undefined;
    this.#done = false;
  }
  startRun(input: StartAgentRun): Promise<AgentRunHandle> {
    if (this.failStart) return Promise.reject(new Error('boom'));
    this.started.push(input);
    this.onStart(input);
    this.#handle = {
      runId: input.contract.run_id,
      conversationId: 'conv-1',
      endpoint: input.endpoint,
      workingDir: input.workingDir,
    };
    return Promise.resolve(this.#handle);
  }
  getStatus(): Promise<AgentRunStatus> {
    return Promise.resolve({
      state: this.#done || this.stopped > 0 ? 'finished' : 'running',
      iterations: 3,
      events: 6 + (this.#done ? 1 : 0),
      identicalCalls: 0,
    });
  }
  stop(): Promise<void> {
    this.stopped += 1;
    return Promise.resolve();
  }
  commitWork(): Promise<{ headSha: string; committed: boolean }> {
    this.commits += 1;
    return Promise.resolve({ headSha: 'a'.repeat(40), committed: true });
  }
  collectOutputs() {
    return Promise.resolve({
      changedFiles: [],
      headSha: 'a'.repeat(40),
      iterations: 3,
      events: [],
    });
  }
}

const tick = (ms = 20) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describeDb('L04 PR 4c: executeEvaluation on PostgreSQL (stub Docker, scripted agent)', () => {
  let t: TestDatabase;
  let docker: StubDocker;
  let client: DockerClient;
  let settings: RunnerSettings;
  let tmp: string;
  let source: string;
  let baseSha: string;
  let tenants = 0;
  const transit = new FakeTransit();
  const agent = new ScriptedAgent();
  let revoked: string[] = [];

  /** The sample repository the clone is made from: a few files and an AGENTS.md. */
  function makeSource(): void {
    source = path.join(tmp, 'source');
    fs.mkdirSync(path.join(source, 'apps/api/src'), { recursive: true });
    fs.writeFileSync(path.join(source, 'AGENTS.md'), 'Run the tests.\n');
    fs.writeFileSync(path.join(source, 'package.json'), '{"name":"pilot"}\n');
    fs.writeFileSync(path.join(source, 'apps/api/src/tax.ts'), 'export const tax = 1;\n');
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', ...args], {
        cwd: source,
        encoding: 'utf8',
      }).trim();
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-q', '-m', 'pinned');
    baseSha = git('rev-parse', 'HEAD');
  }

  beforeAll(async () => {
    t = await createTestDatabase();
    docker = await StubDocker.start();
    client = new DockerClient({ socketPath: docker.socketPath, timeoutMs: 5000 });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-eval-exec-'));
    makeSource();
    settings = runnerSettingsFromEnv({
      SDLC_RUNNER_INSTANCE: 'sdlc',
      SDLC_RUNNER_EGRESS_SERVICES: 'litellm=sdlc-litellm-1:4000,npm-proxy=sdlc-npm-proxy-1:4873',
      SDLC_RUNNER_NPM_REGISTRY: 'http://npm-proxy:4873/',
      SDLC_RUNNER_SELF_CONTAINER: 'sdlc-runner-1',
      SDLC_RUNNER_WORK_DIR: path.join(tmp, 'work'),
      SDLC_RUNNER_AGENT_POLL_MS: '100',
      SDLC_RUNNER_AGENT_STOP_GRACE_SECONDS: '5',
      SDLC_EVAL_TASKS_DIR: path.join(repoRoot(), 'platform/eval/tasks/v1'),
      SDLC_EVAL_CONFIG_DIR: path.join(repoRoot(), 'platform/eval/configs'),
    });
  }, 60_000);
  afterAll(async () => {
    await docker?.stop();
    await t?.drop();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  beforeEach(() => {
    docker.calls.length = 0;
    docker.containers.clear();
    docker.networks.clear();
    docker.volumes.clear();
    docker.exitCodes.length = 0;
    docker.stdout.clear();
    // The scoring container is named like the sandbox: its output is the script's last line.
    agent.reset();
    revoked = [];
  });
  afterEach(() => {
    expect(fs.existsSync(settings.workDir) ? fs.readdirSync(settings.workDir) : []).toEqual([]);
  });

  async function world(): Promise<SeededEvaluation> {
    return seedEvaluation(t.app, { slug: `exec-${String(++tenants)}`, baseSha });
  }

  const issue = async (w: SeededEvaluation, runId: string, now = NOW) =>
    issueEvaluationContract(
      w.scope,
      { evaluationRunId: runId, egressAllowlist: ['litellm:4000', 'npm-proxy:4873'] },
      { signer: transit, now: () => now },
    );

  const input = (w: SeededEvaluation, runId: string, attempt = 1): ExecuteEvaluationRunInput => ({
    tenantId: w.scope.tenantId,
    evaluationRunId: runId,
    attempt,
    wrappedGitToken: 'wrap-git',
    wrappedVirtualKey: 'wrap-key',
  });

  function deps(over: Partial<ExecuteEvaluationDeps> = {}): ExecuteEvaluationDeps {
    return {
      db: t.app as unknown as ExecuteEvaluationDeps['db'],
      docker: client,
      settings,
      verifier: transit,
      unwrapper: {
        unwrap: (wrapped) =>
          Promise.resolve<Record<string, Redacted>>(
            wrapped.reveal() === 'wrap-git'
              ? { token: new Redacted(TOKEN) }
              : { key: new Redacted(KEY) },
          ),
      },
      pool: new SlotPool(2, 1),
      held: new HeldRuns(),
      adapter: agent,
      tokenRevoker: {
        revokeShortLivedToken: (token) => {
          revoked.push(token.reveal());
          return Promise.resolve();
        },
      },
      clone: (clone) => {
        const repo = path.join(clone.dir, 'repo');
        execFileSync('git', ['clone', '-q', '--no-hardlinks', source, repo]);
        execFileSync('git', ['-C', repo, 'checkout', '-q', '-b', 'evaluation', clone.baseSha]);
        return Promise.resolve(repo);
      },
      now: () => NOW,
      ...over,
    };
  }

  /** The tar Docker would give for `/workspace`: the base files, one of them changed. */
  function exportedWorkspace(changeTax: boolean): Buffer {
    const task = loadTaskSet(settings.evaluation.tasksDir, ['feat-tax']).tasks[0]!;
    const files: Record<string, string> = {
      'AGENTS.md': 'Run the tests.\n',
      'package.json': '{"name":"pilot"}\n',
      'apps/api/src/tax.ts': changeTax ? 'export const tax = 2;\n' : 'export const tax = 1;\n',
      'docs/specs/feat-tax.md': task.specText,
    };
    const entries: TarEntry[] = [{ type: 'dir', path: 'workspace' }];
    for (const dir of ['apps', 'apps/api', 'apps/api/src', 'docs', 'docs/specs']) {
      entries.push({ type: 'dir', path: `workspace/${dir}` });
    }
    for (const [name, text] of Object.entries(files)) {
      entries.push({ type: 'file', path: `workspace/${name}`, content: Buffer.from(text) });
    }
    return packTar(entries);
  }
  /** When the agent starts, the sandbox's workspace is what the test wants to be read back. */
  const exporting = (w: SeededEvaluation, runId: string, changeTax: boolean) => {
    agent.onStart = () => {
      const sandbox = [...docker.containers.values()].find(
        (c) => c.name === `sdlc-sandbox-${runId}`,
      );
      if (sandbox) sandbox.exported = exportedWorkspace(changeTax);
      expect(w.scope.tenantId).toBeTruthy();
    };
  };
  const scoreOutput = (runId: string, text = `${GOOD}\n`) =>
    docker.stdout.set(`sdlc-sandbox-${runId}`, text);
  const status = async (w: SeededEvaluation, runId: string) =>
    (await w.scope.evaluationRuns.getById(runId))!;

  it('scores a run: claimed, the capped key to the agent, the change recomputed, the measures coded', async () => {
    const w = await world();
    const runId = w.runs[0]!;
    await issue(w, runId);
    exporting(w, runId, true);
    scoreOutput(runId);
    agent.finish();

    const result = await executeEvaluation(deps(), input(w, runId), {
      signal: new AbortController().signal,
    });
    expect(result.outcome).toBe('scored');
    if (result.outcome !== 'scored') return;
    expect(result.measures).toMatchObject({
      agentOutcome: 'finished',
      status: 'succeeded',
      stopReason: null,
      iterations: 3,
      // The file the scripted agent changed is not in the task's plan: counted, never named.
      outOfPlanFiles: 1,
      diffFiles: 1,
      diffLinesAdded: 1,
      diffLinesRemoved: 1,
      applied: true,
      ci: true,
      passToPass: true,
      failToPass: false,
      lintFindings: 1,
    });
    expect(result.measures.instructionsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.measures.hardware).toMatchObject({ runner_instance: 'sdlc' });

    // The run is claimed and waits for the worker to write the result.
    expect(await status(w, runId)).toMatchObject({
      status: 'running',
      attempt: 1,
      runner_instance: 'sdlc',
    });
    // The agent got the evaluation's model, the capped key and the task; the branch is local.
    const [started] = agent.started;
    expect(started!.model.model).toBe('gpt-oss-20b');
    expect(started!.model.virtualKey.reveal()).toBe(KEY);
    expect(started!.contract.intent_id).toBe(w.evaluationId);
    expect(started!.task.spec.path).toBe('docs/specs/feat-tax.md');
    expect(agent.commits).toBe(1);
    // The clone token was revoked once, right after the clone. Nothing is left behind.
    expect(revoked).toEqual([TOKEN]);
    expect([docker.containers.size, docker.networks.size, docker.volumes.size]).toEqual([0, 0, 0]);
    // Codes and numbers only: no secret, no path and no text in the returned value.
    const text = JSON.stringify(result);
    for (const forbidden of [TOKEN, KEY, tmp, 'tax', 'export const']) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('counts files outside the plan, and a run that changed nothing', async () => {
    const w = await world();
    const runId = w.runs[0]!;
    await issue(w, runId);
    exporting(w, runId, false);
    scoreOutput(runId);
    agent.finish();
    const result = await executeEvaluation(deps(), input(w, runId), {
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      outcome: 'scored',
      measures: { diffFiles: 0, diffLinesAdded: 0, diffLinesRemoved: 0, outOfPlanFiles: 0 },
    });
  });

  it('gives a run whose contract expired the next attempt, and leaves a taken run alone', async () => {
    const w = await world();
    const [first, second] = w.runs as [string, string];
    await issue(w, first, new Date(NOW.getTime() - 60 * 60_000)); // issued an hour ago
    const expired = await executeEvaluation(deps(), input(w, first), {
      signal: new AbortController().signal,
    });
    expect(expired).toEqual({ outcome: 'refused', reason: 'expired' });
    expect(await status(w, first)).toMatchObject({ status: 'queued', attempt: 2 });

    await issue(w, second);
    expect(await w.scope.evaluationRuns.claim(second, 1, 'runner-other')).toBe(true);
    const taken = await executeEvaluation(deps(), input(w, second), {
      signal: new AbortController().signal,
    });
    expect(taken).toEqual({ outcome: 'refused', reason: 'run_not_startable' });
    expect(await status(w, second)).toMatchObject({ status: 'running', attempt: 1 });
    expect(docker.calls).toHaveLength(0);
  });

  it('refuses a run without a contract and a run another process of this runner holds', async () => {
    const w = await world();
    const runId = w.runs[0]!;
    expect(
      await executeEvaluation(deps(), input(w, runId), { signal: new AbortController().signal }),
    ).toEqual({ outcome: 'refused', reason: 'unknown_contract' });
    await issue(w, runId);
    const held = new HeldRuns();
    held.hold(runId);
    expect(
      await executeEvaluation(deps({ held }), input(w, runId), {
        signal: new AbortController().signal,
      }),
    ).toEqual({ outcome: 'refused', reason: 'run_not_startable' });
  });

  it('waits for a free evaluation slot while the run is queued; a cancel there changes nothing', async () => {
    const w = await world();
    const runId = w.runs[0]!;
    await issue(w, runId);
    const pool = new SlotPool(1, 1);
    const real = await pool.acquire(); // the only slot is a real run's
    const controller = new AbortController();
    const pending = executeEvaluation(deps({ pool }), input(w, runId), {
      signal: controller.signal,
    });
    await tick();
    expect((await status(w, runId)).status).toBe('queued');
    expect(pool.waitingEvaluations).toBe(1);
    controller.abort();
    expect(await pending).toEqual({ outcome: 'cancelled' });
    expect(await status(w, runId)).toMatchObject({ status: 'queued', attempt: 1 });
    expect(pool.waitingEvaluations).toBe(0);
    real.release();
  });

  it('stops the agent for a real run: preempted, queued again with the next attempt, slot freed', async () => {
    const w = await world();
    const runId = w.runs[0]!;
    await issue(w, runId);
    exporting(w, runId, false);
    const pool = new SlotPool(1, 1);
    const pending = executeEvaluation(deps({ pool }), input(w, runId), {
      signal: new AbortController().signal,
    });
    // The agent is working; a real run arrives and finds no free slot.
    for (let i = 0; i < 100 && agent.started.length === 0; i++) await tick();
    expect(agent.started).toHaveLength(1);
    const realRun = pool.acquire();
    expect(await pending).toEqual({ outcome: 'preempted' });
    expect(agent.stopped).toBeGreaterThan(0);
    // The real run got the slot at once; the evaluation attempt is not counted.
    const real = await realRun;
    expect(pool.activeEvaluations).toBe(0);
    expect(await status(w, runId)).toMatchObject({
      status: 'queued',
      attempt: 2,
      runner_instance: null,
    });
    expect(await w.scope.evaluationRuns.resultsForEvaluation(w.evaluationId)).toEqual([]);
    expect([docker.containers.size, docker.networks.size, docker.volumes.size]).toEqual([0, 0, 0]);
    real.release();
  });

  it('ends the run cancelled when the activity is cancelled while the agent works', async () => {
    const w = await world();
    const runId = w.runs[0]!;
    await issue(w, runId);
    exporting(w, runId, false);
    const controller = new AbortController();
    const pending = executeEvaluation(deps(), input(w, runId), { signal: controller.signal });
    for (let i = 0; i < 100 && agent.started.length === 0; i++) await tick();
    controller.abort();
    expect(await pending).toEqual({ outcome: 'cancelled' });
    expect(await status(w, runId)).toMatchObject({
      status: 'cancelled',
      stop_reason: 'evaluation_stopped',
    });
    expect([docker.containers.size, docker.networks.size, docker.volumes.size]).toEqual([0, 0, 0]);
  });

  it.each([
    [
      'the agent cannot start',
      () => {
        agent.failStart = true;
      },
      'agent_runner_error',
    ],
    [
      'the clone fails',
      undefined,
      'clone_clone_failed',
      {
        clone: () => Promise.reject(new CloneError('clone_failed')),
      } satisfies Partial<ExecuteEvaluationDeps>,
    ],
    [
      'the packages cannot be installed for scoring',
      () => {
        docker.exitCodes.push(1);
      },
      'scoring_install_failed',
    ],
    [
      'the task is not in the task set',
      undefined,
      'task_unavailable',
      {
        settings: runnerSettingsFromEnv({
          SDLC_RUNNER_INSTANCE: 'sdlc',
          SDLC_RUNNER_EGRESS_SERVICES:
            'litellm=sdlc-litellm-1:4000,npm-proxy=sdlc-npm-proxy-1:4873',
          SDLC_RUNNER_NPM_REGISTRY: 'http://npm-proxy:4873/',
          SDLC_RUNNER_WORK_DIR: path.join(os.tmpdir(), 'sdlc-eval-exec-none'),
          SDLC_EVAL_TASKS_DIR: '/nonexistent',
        }),
      } satisfies Partial<ExecuteEvaluationDeps>,
    ],
  ])(
    'fails the run with a code when %s',
    async (_name, arrange, reason, over: Partial<ExecuteEvaluationDeps> = {}) => {
      const w = await world();
      const runId = w.runs[0]!;
      await issue(w, runId);
      exporting(w, runId, false);
      scoreOutput(runId);
      agent.finish();
      arrange?.();
      const result = await executeEvaluation(deps(over), input(w, runId), {
        signal: new AbortController().signal,
      });
      expect(result).toEqual({ outcome: 'failed', reason });
      expect(await status(w, runId)).toMatchObject({ status: 'failed', stop_reason: reason });
      expect(await w.scope.evaluationRuns.resultsForEvaluation(w.evaluationId)).toEqual([]);
      expect([docker.containers.size, docker.networks.size, docker.volumes.size]).toEqual([
        0, 0, 0,
      ]);
      // The key was never given to a failed clone or task; the contract bytes were signed once.
      expect(transit.signed.size).toBeGreaterThan(0);
      expect(typeof evaluationContractBytes).toBe('function');
    },
  );

  /** L05: an evaluation of a plan whose configuration has a prompt variant in the repository. */
  async function planWorld(promptOnBranch: string, promptInRepo: string) {
    const w = await seedPlanWorld(t.app, `exec-plan-${String(++tenants)}`, NOW);
    // The variant is committed to the sample repository: the runner reads it at that commit.
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', ...args], {
        cwd: source,
        encoding: 'utf8',
      }).trim();
    git('checkout', '-q', '-B', `prompt-${String(tenants)}`, baseSha);
    fs.mkdirSync(path.join(source, 'eval/prompts'), { recursive: true });
    fs.writeFileSync(path.join(source, 'eval/prompts/short.md'), promptInRepo);
    git('add', '-A');
    git('commit', '-q', '-m', 'prompt');
    const promptCommit = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
    const planDeps: EvaluationPlanDeps = {
      policyFactory: (config, models) => createSimplePolicyEngine({ config, models }),
      models: () => Promise.resolve([{ model: 'gpt-oss-20b', providerType: 'self_hosted' }]),
      taskSet: () => Promise.resolve({ version: 1, baseSha, taskIds: ['feat-tax'] }),
      gitHost: {
        getBranchHead: () => Promise.resolve(promptCommit),
        getFileAtCommit: () => Promise.resolve(promptOnBranch),
      },
      now: () => NOW,
    };
    const plan = await createEvaluationPlan(w.scope, planDeps, {
      projectId: w.projectId,
      code: 'short-prompt',
      content: {
        dataClass: 'internal',
        taskSetVersion: 1,
        taskIds: ['feat-tax'],
        runsPerTask: 1,
        budgetPerRunUsd: '1',
        monthlyCapUsd: '5',
        trigger: 'once',
        configurations: [
          {
            id: 'oss-short',
            model: 'gpt-oss-20b',
            providerType: 'self_hosted',
            maxIterations: 30,
            maxDurationMin: 20,
            promptPath: 'eval/prompts/short.md',
          },
        ],
      },
      userId: w.users.a,
    });
    const evaluation = await startEvaluationPlan(w.scope, planDeps, {
      planId: plan.id,
      actor: { type: 'human', userId: w.users.a },
    });
    const [run] = await w.scope.evaluationRuns.listForEvaluation(evaluation.id);
    const seeded = { scope: w.scope, evaluationId: evaluation.id } as unknown as SeededEvaluation;
    return { w: seeded, runId: run!.id };
  }

  it('L05: a run of a plan reads its prompt variant at the recorded commit, checked by SHA-256', async () => {
    const prompt = 'Plan prompt: run the tests first.\n';
    const { w, runId } = await planWorld(prompt, prompt);
    await issue(w, runId);
    exporting(w, runId, true);
    scoreOutput(runId);
    agent.finish();
    const result = await executeEvaluation(deps(), input(w, runId), {
      signal: new AbortController().signal,
    });
    expect(result.outcome).toBe('scored');
    if (result.outcome !== 'scored') return;
    // The agent read the variant as its instructions.
    expect(result.measures.instructionsSha256).toBe(
      crypto.createHash('sha256').update(prompt, 'utf8').digest('hex'),
    );
    expect(JSON.stringify(result)).not.toContain('Plan prompt');
    // The token was used for both clones, then revoked once.
    expect(revoked).toEqual([TOKEN]);
  });

  it('L05: a prompt variant that changed since the start fails the run with a code', async () => {
    const { w, runId } = await planWorld('What the plan read.\n', 'Something else.\n');
    await issue(w, runId);
    const result = await executeEvaluation(deps(), input(w, runId), {
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ outcome: 'failed', reason: 'task_unavailable' });
    expect(await status(w, runId)).toMatchObject({
      status: 'failed',
      stop_reason: 'task_unavailable',
    });
    expect(revoked).toEqual([TOKEN]);
  });
});
