// D-08 L07 PR 4c on PostgreSQL with the Docker stub, a scripted agent and a real Git repository
// (design/ADR-M85 §2.10): an evaluation run on a project's own task set.
// - the contract names the kind `project`, the commit of the cards and the run's base commit;
// - the runner clones the project's repository at the task's base commit, reads the card at the
//   evaluation's commit with the approved SHA-256 and the spec at its commit, and scores with the
//   hidden tests of the merge commit (never in the agent's workspace);
// - a card that changed at that commit fails the run with a code (`task_unavailable`);
// - nothing is left in Docker or on disk.
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
import { renderTaskCard, type TaskCard } from '@sdlc/eval';
import { Redacted } from '@sdlc/secrets';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';

import {
  DockerClient,
  executeEvaluation,
  HeldRuns,
  runnerSettingsFromEnv,
  SlotPool,
  type ExecuteEvaluationDeps,
  type RunnerSettings,
} from '../../../apps/runner/src/index.js';
import { packTar, type TarEntry } from '../../../apps/runner/src/workspace/tar.js';
import type { TenantScope } from '../../../packages/core/src/db/tenant-scope.js';
import { issueEvaluationContract } from '../../../packages/core/src/evaluation/index.js';
import { StubDocker } from '../../runner/stub-docker.js';
import { repoRoot } from '../../workspace/helpers';
import { seedTaskWorld, TASK_NOW } from '../task-seed.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

const GOOD = '{"applied":true,"ci":true,"pass_to_pass":true,"fail_to_pass":true,"lint":0}';
const TOKEN = 'ghs_projectRunTokenCanary000000000';
const KEY = 'sk-project-run-key-canary-000000000';
const CARD_PATH = '.sdlc/eval-tasks/tax-rule.yaml';
const SPEC = '# Tax\n\nAC1: the tax is 10%.\n';
const sha256 = (text: string) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

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

/** An agent that finishes at once; the test sets the sandbox's export when it starts. */
class FinishingAgent implements AgentAdapter {
  started: StartAgentRun[] = [];
  onStart: (input: StartAgentRun) => void = () => undefined;
  startRun(input: StartAgentRun): Promise<AgentRunHandle> {
    this.started.push(input);
    this.onStart(input);
    return Promise.resolve({
      runId: input.contract.run_id,
      conversationId: 'conv-1',
      endpoint: input.endpoint,
      workingDir: input.workingDir,
    });
  }
  getStatus(): Promise<AgentRunStatus> {
    return Promise.resolve({ state: 'finished', iterations: 2, events: 4, identicalCalls: 0 });
  }
  stop(): Promise<void> {
    return Promise.resolve();
  }
  commitWork(): Promise<{ headSha: string; committed: boolean }> {
    return Promise.resolve({ headSha: 'a'.repeat(40), committed: true });
  }
  collectOutputs() {
    return Promise.resolve({
      changedFiles: [],
      headSha: 'a'.repeat(40),
      iterations: 2,
      events: [],
    });
  }
}

interface Source {
  readonly dir: string;
  readonly base: string;
  readonly merge: string;
  readonly cardCommit: string;
  readonly card: string;
  /** A later commit where the card changed. */
  readonly changedCommit: string;
}

describeDb("L07 PR 4c: an evaluation run on a project's task (stub Docker, real Git)", () => {
  let t: TestDatabase;
  let docker: StubDocker;
  let client: DockerClient;
  let settings: RunnerSettings;
  let tmp: string;
  let src: Source;
  let tenants = 0;
  let revoked: string[] = [];
  let patches: { basePatch: string; agentPatch: string }[] = [];
  const transit = new FakeTransit();
  const agent = new FinishingAgent();

  function makeSource(): Source {
    const dir = path.join(tmp, 'source');
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', ...args], {
        cwd: dir,
        encoding: 'utf8',
      }).trim();
    const write = (file: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), text);
    };
    fs.mkdirSync(dir, { recursive: true });
    git('init', '-q', '-b', 'main');
    write('package.json', '{"name":"shop"}\n');
    write('src/tax.ts', 'export const tax = 0;\n');
    write('docs/specs/tax.md', SPEC);
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    write('src/tax.ts', 'export const tax = 0.1;\n');
    write('src/tax.spec.ts', 'expect(tax).toBe(0.1);\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'merge');
    const merge = git('rev-parse', 'HEAD');
    const card: TaskCard = {
      id: 'tax-rule',
      intent: 'INT-2026-0001',
      baseCommit: base,
      mergeCommit: merge,
      spec: { path: 'docs/specs/tax.md', commit: base, sha256: sha256(SPEC) },
      hiddenTests: ['src/tax.spec.ts'],
      plannedFiles: ['src/tax.ts'],
      failToPass: ['pnpm test -- src/tax.spec.ts'],
      passToPass: ['pnpm test'],
      ci: ['pnpm lint'],
    };
    const text = renderTaskCard(card);
    write(CARD_PATH, text);
    git('add', '-A');
    git('commit', '-q', '-m', 'card');
    const cardCommit = git('rev-parse', 'HEAD');
    write(CARD_PATH, `${text}# changed\n`);
    git('add', '-A');
    git('commit', '-q', '-m', 'card changed');
    return { dir, base, merge, cardCommit, card: text, changedCommit: git('rev-parse', 'HEAD') };
  }

  beforeAll(async () => {
    t = await createTestDatabase();
    docker = await StubDocker.start();
    client = new DockerClient({ socketPath: docker.socketPath, timeoutMs: 5000 });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-project-run-'));
    src = makeSource();
    settings = runnerSettingsFromEnv({
      SDLC_RUNNER_INSTANCE: 'sdlc',
      SDLC_RUNNER_EGRESS_SERVICES: 'litellm=sdlc-litellm-1:4000,npm-proxy=sdlc-npm-proxy-1:4873',
      SDLC_RUNNER_NPM_REGISTRY: 'http://npm-proxy:4873/',
      SDLC_RUNNER_SELF_CONTAINER: 'sdlc-runner-1',
      SDLC_RUNNER_WORK_DIR: path.join(tmp, 'work'),
      SDLC_RUNNER_AGENT_POLL_MS: '100',
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
    agent.started = [];
    revoked = [];
    patches = [];
  });
  afterEach(() => {
    expect(fs.existsSync(settings.workDir) ? fs.readdirSync(settings.workDir) : []).toEqual([]);
  });

  /** An approved task and an evaluation of the project's set, with its contract issued. */
  async function queued(cardsAt: string): Promise<{ scope: TenantScope; runId: string }> {
    const w = await seedTaskWorld(t.app, `project-run-${String(++tenants)}`);
    const { scope } = w;
    const { task } = await scope.evaluationTasks.register({
      projectId: w.projectId,
      taskId: 'tax-rule',
      intentId: w.intentId,
      cardCommit: src.cardCommit,
      cardSha256: sha256(src.card),
      baseCommit: src.base,
      mergeCommit: src.merge,
      registeredBy: null,
    });
    await scope.evaluationTasks.startCheck(task.id, task.card_sha256);
    await scope.evaluationTasks.recordCheck(task.id, task.card_sha256, { status: 'checked' });
    const evaluation = await scope.evaluations.create({
      projectId: w.projectId,
      dataClass: 'internal',
      taskSetKind: 'project',
      taskSetVersion: null,
      taskSetCommit: cardsAt,
      taskBaseShas: { 'tax-rule': src.base },
      baseSha: null,
      configName: 'local',
      taskIds: ['tax-rule'],
      configurations: [
        {
          id: 'gpt-oss-20b',
          model: 'gpt-oss-20b',
          providerType: 'self_hosted',
          agentVersion: '1.0.0',
          maxIterations: 30,
          maxDurationMin: 20,
        },
      ],
      runsPerTask: 1,
      budgetUsd: '1',
      startedBy: null,
      now: TASK_NOW,
    });
    const [run] = await scope.evaluationRuns.listForEvaluation(evaluation.id);
    await issueEvaluationContract(
      scope,
      { evaluationRunId: run!.id, egressAllowlist: ['litellm:4000', 'npm-proxy:4873'] },
      { signer: transit, now: () => TASK_NOW },
    );
    return { scope, runId: run!.id };
  }

  const input = (scope: TenantScope, runId: string): ExecuteEvaluationRunInput => ({
    tenantId: scope.tenantId,
    evaluationRunId: runId,
    attempt: 1,
    wrappedGitToken: 'wrap-git',
    wrappedVirtualKey: 'wrap-key',
  });

  const deps = (): ExecuteEvaluationDeps => ({
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
    adapters: { openhands: agent },
    tokenRevoker: {
      revokeShortLivedToken: (token) => {
        revoked.push(token.reveal());
        return Promise.resolve();
      },
    },
    clone: (clone) => {
      const repo = path.join(clone.dir, 'repo');
      execFileSync('git', ['clone', '-q', '--no-hardlinks', src.dir, repo]);
      execFileSync('git', ['-C', repo, 'checkout', '-q', '-b', 'evaluation', clone.baseSha]);
      return Promise.resolve(repo);
    },
    now: () => TASK_NOW,
    onPatch: (p) => patches.push(p),
  });

  /** The sandbox's `/workspace` as Docker gives it back: the base, with the agent's change. */
  function exported(): Buffer {
    const files: Record<string, string> = {
      'package.json': '{"name":"shop"}\n',
      'src/tax.ts': 'export const tax = 0.1;\n',
      'docs/specs/tax.md': SPEC,
      'docs/specs/tax-rule.md': SPEC,
    };
    const entries: TarEntry[] = [{ type: 'dir', path: 'workspace' }];
    for (const dir of ['src', 'docs', 'docs/specs']) {
      entries.push({ type: 'dir', path: `workspace/${dir}` });
    }
    for (const [name, text] of Object.entries(files)) {
      entries.push({ type: 'file', path: `workspace/${name}`, content: Buffer.from(text) });
    }
    return packTar(entries);
  }

  it("scores a run from the task's card: its base commit, its spec, the hidden tests apart", async () => {
    const { scope, runId } = await queued(src.cardCommit);
    const contract = (await scope.evaluationContracts.getForAttempt(runId, 1))!.contract_json;
    expect(contract).toMatchObject({
      base_sha: src.base,
      task_set_kind: 'project',
      task_set_version: null,
      task_set_commit: src.cardCommit,
    });
    agent.onStart = () => {
      const sandbox = [...docker.containers.values()].find(
        (c) => c.name === `sdlc-sandbox-${runId}`,
      );
      if (sandbox) sandbox.exported = exported();
    };
    docker.stdout.set(`sdlc-sandbox-${runId}`, `${GOOD}\n`);

    const result = await executeEvaluation(deps(), input(scope, runId), {
      signal: new AbortController().signal,
    });
    expect(result.outcome).toBe('scored');
    if (result.outcome !== 'scored') return;
    expect(result.measures).toMatchObject({
      applied: true,
      failToPass: true,
      outOfPlanFiles: 0,
      diffFiles: 1,
    });
    // The agent read the spec where a task of set v1 has it, at the base commit of the task.
    const [started] = agent.started;
    expect(started!.task.spec.path).toBe('docs/specs/tax-rule.md');
    expect(started!.task.plan.plannedFiles).toEqual(['src/tax.ts']);
    // The hidden test is never in the agent's change or in the base the agent got.
    expect(patches).toHaveLength(1);
    expect(patches[0]!.agentPatch).toContain('src/tax.ts');
    expect(`${patches[0]!.basePatch}${patches[0]!.agentPatch}`).not.toContain('tax.spec.ts');
    expect(revoked).toEqual([TOKEN]);
    expect([docker.containers.size, docker.networks.size, docker.volumes.size]).toEqual([0, 0, 0]);
    const text = JSON.stringify(result);
    for (const forbidden of [TOKEN, KEY, tmp, 'tax', 'AC1']) expect(text).not.toContain(forbidden);
  });

  it('fails the run with a code when the card at the evaluation commit is not the approved one', async () => {
    const { scope, runId } = await queued(src.changedCommit);
    const result = await executeEvaluation(deps(), input(scope, runId), {
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ outcome: 'failed', reason: 'task_unavailable' });
    expect(await scope.evaluationRuns.getById(runId)).toMatchObject({
      status: 'failed',
      stop_reason: 'task_unavailable',
    });
    expect(agent.started).toHaveLength(0);
    expect([docker.containers.size, docker.networks.size, docker.volumes.size]).toEqual([0, 0, 0]);
  });
});
