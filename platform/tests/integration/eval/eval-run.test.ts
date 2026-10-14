// The evaluation harness (task L02, design/ADR-M78): `pnpm eval`. DEVELOPER MACHINES ONLY, never in
// CI. Needs Docker, internet (the sample repository at its pinned commit and the npm packages, once)
// and, for an `ollama` configuration, Ollama on this machine with the configuration's local tag.
// No secret is involved: Ollama has no key; the LiteLLM keys are random values of this run.
//
// Two modes (SDLC_EVAL_MODE):
// - `check`: checks the task set itself, without an agent. For every task, the reference solution
//   resolves it in the scoring container, and the base without a change does not.
// - `evaluate` (default): every configuration × task × run 1…N through the platform's own agent
//   path (the runner drives OpenHands in a node24 sandbox; the model through LiteLLM with a capped
//   virtual key; packages through Verdaccio), then scored in an isolated container (ADR-M78 §2.3).
//   One JSON result per run in SDLC_EVAL_OUT, numbers and codes only; existing results are skipped,
//   so a stopped evaluation continues where it stopped.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { OpenHandsAdapter } from '@sdlc/adapter-agent-openhands';
import { LiteLLMGateway } from '@sdlc/adapter-model-litellm';
import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';
import { loadProjectConfig } from '@sdlc/config';
import { Redacted } from '@sdlc/secrets';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildRunResult,
  ensureClone,
  hasRunResult,
  litellmModelList,
  loadConfigurations,
  loadTaskSet,
  LocalExecutor,
  prepareBase,
  writeRunResult,
  type EvalConfiguration,
  type EvalTask,
  type TaskSet,
  writeDiff,
} from '@sdlc/eval';
import {
  DockerClient,
  driveAgent,
  teardownSandbox,
  type AgentDriveDeps,
} from '../../../apps/runner/src/index.js';
import { CostController } from '../../../packages/core/src/cost/index.js';
import { fromMicros, toMicros } from '../../../packages/core/src/cost/money.js';
import { formatUsd6 } from '../../../packages/core/src/cost/report.js';
import { changesStep, here as agentDir, NODE_IMAGE, secret, startAgentRun } from '../agent/helpers';
import { createTestDatabase, type TestDatabase } from '../db/helpers.js';
import { deployDir } from '../../deploy/compose';
import { docker, dockerSocket, quietly } from '../runner/live-helpers';
import { buildSandboxImage, VERDACCIO } from '../sandbox-image/helpers';
import { repoRoot } from '../../workspace/helpers';

const enabled = process.env.SDLC_EVAL === '1' && !!process.env.SDLC_TEST_DATABASE_URL;
const MODE = process.env.SDLC_EVAL_MODE === 'check' ? 'check' : 'evaluate';
const OLLAMA_URL = process.env.SDLC_OLLAMA_URL ?? 'http://host.docker.internal:11434';
const STUB_KEY = `sk-eval-stub-${crypto.randomBytes(12).toString('hex')}`;
const suffix = crypto.randomBytes(4).toString('hex');
const names = {
  net: `sdlc-eval-platform-${suffix}`,
  litellm: `sdlc-eval-litellm-${suffix}`,
  stub: `sdlc-eval-stub-${suffix}`,
  npm: `sdlc-eval-npm-${suffix}`,
  registry: `sdlc-eval-registry-${suffix}`,
};
/** Verdaccio's storage survives evaluations, so packages are fetched once. */
const NPM_CACHE_VOLUME = 'sdlc-eval-npm-cache';

const list = (value: string | undefined): string[] | undefined =>
  value === undefined || value.trim() === '' ? undefined : value.split(',').map((v) => v.trim());

function settings() {
  const root = repoRoot();
  const out = process.env.SDLC_EVAL_OUT ?? '';
  if (MODE === 'evaluate') {
    if (!path.isAbsolute(out)) throw new Error('SDLC_EVAL_OUT must be an absolute folder');
    if (!path.relative(root, out).startsWith('..')) {
      throw new Error('SDLC_EVAL_OUT must be outside the repository');
    }
  }
  const runs = Number(process.env.SDLC_EVAL_N ?? '5');
  if (!Number.isInteger(runs) || runs < 1 || runs > 50) throw new Error('SDLC_EVAL_N: 1 to 50');
  return {
    out,
    runs,
    cache: process.env.SDLC_EVAL_CACHE ?? path.join(os.homedir(), '.cache', 'sdlc-eval'),
    tasksDir: process.env.SDLC_EVAL_TASKS_DIR ?? path.join(root, 'platform/eval/tasks/v1'),
    configFile: process.env.SDLC_EVAL_CONFIG ?? path.join(root, 'platform/eval/configs/local.yaml'),
    tasks: list(process.env.SDLC_EVAL_TASKS),
    configurations: list(process.env.SDLC_EVAL_CONFIGURATIONS),
  };
}

function litellmImage(): string {
  const compose = fs.readFileSync(path.join(deployDir, 'docker-compose.yml'), 'utf8');
  const image = /image: (ghcr\.io\/berriai\/litellm:\S+)/.exec(compose)?.[1];
  if (!image) throw new Error('LiteLLM image not found in docker-compose.yml');
  return image;
}

/** Verdaccio on `names.net`, its storage kept between evaluations (scoring step 1 and the agent). */
function startPackageProxy(): void {
  docker('network', 'create', names.net);
  docker('pull', '-q', VERDACCIO);
  docker(
    'run',
    '-d',
    '--name',
    names.npm,
    '--network',
    names.net,
    '--read-only',
    '--tmpfs',
    '/tmp',
    '--cap-drop',
    'ALL',
    '-v',
    `${NPM_CACHE_VOLUME}:/verdaccio/storage`,
    '-v',
    `${path.join(repoRoot(), 'platform/deploy/verdaccio/config.yaml')}:/verdaccio/conf/config.yaml:ro`,
    VERDACCIO,
  );
}

function newExecutor(sandboxImage: string, clone: string, commit: string): LocalExecutor {
  return new LocalExecutor({
    image: sandboxImage,
    cloneDir: clone,
    commit,
    proxyContainer: names.npm,
    proxyUrl: `http://${names.npm}:4873`,
  });
}

const policy = (() => {
  const loaded = loadProjectConfig('');
  if (!loaded.ok) throw new Error('default configuration refused');
  return createSimplePolicyEngine({ config: loaded.config });
})();

describe.skipIf(!enabled || MODE !== 'check')('L02: the task set checks itself', () => {
  const s = enabled ? settings() : undefined;
  let set: TaskSet;
  let executor: LocalExecutor;
  let clone: string;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-eval-check-'));

  beforeAll(async () => {
    set = loadTaskSet(s!.tasksDir, s!.tasks);
    clone = ensureClone(s!.cache, set);
    startPackageProxy();
    const sandboxImage =
      process.env.SDLC_SANDBOX_IMAGE || (await buildSandboxImage(names.registry));
    executor = newExecutor(sandboxImage, clone, set.commit);
  }, 1_800_000);

  afterAll(() => {
    quietly('rm', '-f', '-v', names.registry);
    quietly('rm', '-f', names.npm);
    quietly('network', 'rm', names.net);
    fs.rmSync(tmp, { recursive: true, force: true });
  }, 300_000);

  it(
    'every task: the reference solution resolves it, the base does not',
    { timeout: 3_600_000 },
    async () => {
      for (const task of set.tasks) {
        expect(task.solutionPatch, `${task.id}: solution.patch`).not.toBeNull();
        const base = prepareBase({
          clone,
          commit: set.commit,
          task,
          instructionsText: null,
          workDir: fs.mkdtempSync(path.join(tmp, `${task.id}-`)),
        });
        const solved = await executor.score({
          task,
          basePatch: base.basePatch,
          agentPatch: task.solutionPatch!,
        });
        const untouched = await executor.score({
          task,
          basePatch: base.basePatch,
          agentPatch: '',
        });
        process.stderr.write(
          `L02 CHECK ${task.id} solution=${JSON.stringify(solved)} base=${JSON.stringify(untouched)}\n`,
        );
        expect(solved, task.id).toMatchObject({
          applied: true,
          passToPass: true,
          failToPass: true,
          ci: true,
        });
        expect(untouched.failToPass, `${task.id}: the base must fail the hidden tests`).toBe(false);
      }
    },
  );
});

describe.skipIf(!enabled || MODE !== 'evaluate')(
  'L02: evaluate configurations on the task set',
  () => {
    const s = enabled ? settings() : undefined;
    let t: TestDatabase;
    let set: TaskSet;
    let configurations: EvalConfiguration[];
    let executor: LocalExecutor;
    let sandboxImage: string;
    let clone: string;
    let client: DockerClient;
    let controller: CostController | undefined;
    let litellmDb = '';
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-eval-'));
    const masterKey = `sk-eval-${crypto.randomBytes(16).toString('hex')}`;
    let tenants = 0;

    const admin = async (sql: string) => {
      const c = new pg.Client({ connectionString: process.env.SDLC_TEST_DATABASE_URL });
      await c.connect();
      try {
        await c.query(sql);
      } finally {
        await c.end();
      }
    };

    async function startLiteLLM(): Promise<void> {
      litellmDb = `litellm_eval_${suffix}`;
      await admin(`CREATE DATABASE ${litellmDb}`);
      const dbUrl = new URL(process.env.SDLC_TEST_DATABASE_URL!);
      dbUrl.hostname = 'host.docker.internal';
      dbUrl.pathname = `/${litellmDb}`;
      const config = path.join(tmp, 'litellm.yaml');
      fs.writeFileSync(
        config,
        `${litellmModelList(configurations, OLLAMA_URL)}general_settings:\n  master_key: os.environ/LITELLM_MASTER_KEY\n  database_url: os.environ/DATABASE_URL\n`,
        { mode: 0o644 },
      );
      docker(
        'run',
        '-d',
        '--name',
        names.litellm,
        '--network',
        names.net,
        '--add-host',
        'host.docker.internal:host-gateway',
        '-p',
        '127.0.0.1::4000',
        '-e',
        `LITELLM_MASTER_KEY=${masterKey}`,
        '-e',
        `LITELLM_SALT_KEY=sk-salt-${crypto.randomBytes(16).toString('hex')}`,
        '-e',
        `DATABASE_URL=${dbUrl.toString()}`,
        '-v',
        `${config}:/cfg/config.yaml:ro`,
        litellmImage(),
        '--config',
        '/cfg/config.yaml',
        '--port',
        '4000',
        '--telemetry',
        'False',
      );
      const port = docker('port', names.litellm, '4000/tcp').split('\n')[0]!.split(':').pop()!;
      const baseUrl = `http://127.0.0.1:${port}`;
      for (let i = 0; ; i++) {
        if (
          await fetch(`${baseUrl}/health/readiness`)
            .then((r) => r.ok)
            .catch(() => false)
        )
          break;
        if (i > 150) throw new Error('LiteLLM did not become ready');
        await new Promise((r) => setTimeout(r, 2000));
      }
      const gateway = new LiteLLMGateway({
        baseUrl,
        masterKey: new Redacted(masterKey),
        timeoutMs: 60_000,
      });
      controller = new CostController({ gateway, db: t.app });
    }

    beforeAll(async () => {
      set = loadTaskSet(s!.tasksDir, s!.tasks);
      configurations = loadConfigurations(s!.configFile, s!.configurations);
      clone = ensureClone(s!.cache, set);
      t = await createTestDatabase();
      sandboxImage = process.env.SDLC_SANDBOX_IMAGE || (await buildSandboxImage(names.registry));
      client = new DockerClient({ socketPath: dockerSocket(), timeoutMs: 900_000 });
      startPackageProxy();
      executor = newExecutor(sandboxImage, clone, set.commit);
      if (configurations.some((c) => c.model.provider === 'stub')) {
        docker('pull', '-q', NODE_IMAGE);
        docker(
          'run',
          '-d',
          '--name',
          names.stub,
          '--network',
          names.net,
          '--read-only',
          '--cap-drop',
          'ALL',
          '--user',
          '1000:1000',
          '-e',
          `STUB_EXPECTED_KEY=${STUB_KEY}`,
          '-v',
          `${path.join(agentDir, 'stub-model.mjs')}:/stub/stub-model.mjs:ro`,
          NODE_IMAGE,
          'node',
          '/stub/stub-model.mjs',
        );
      }
      if (configurations.some((c) => c.model.provider === 'ollama')) await startLiteLLM();
    }, 3_600_000);

    afterAll(async () => {
      quietly('rm', '-f', '-v', names.litellm, names.stub, names.registry);
      quietly('rm', '-f', names.npm);
      quietly('network', 'rm', names.net);
      fs.rmSync(tmp, { recursive: true, force: true });
      if (litellmDb)
        await admin(`DROP DATABASE IF EXISTS ${litellmDb} WITH (FORCE)`).catch(() => undefined);
      await t?.drop();
    }, 300_000);

    async function runOnce(config: EvalConfiguration, task: EvalTask, run: number): Promise<void> {
      const workDir = fs.mkdtempSync(path.join(tmp, `${task.id}-`));
      const base = prepareBase({
        clone,
        commit: set.commit,
        task,
        instructionsText: config.instructionsText,
        workDir,
      });
      const stub = config.model.provider === 'stub';
      let keyId = '';
      let virtualKey = secret(STUB_KEY);
      const started = Date.now();
      const fixture = await startAgentRun({
        t,
        client,
        image: sandboxImage,
        tmp: workDir,
        suffix,
        slug: `eval-${String(++tenants)}`,
        litellmContainer: stub ? names.stub : names.litellm,
        npmProxyContainer: names.npm,
        model: config.model.name,
        // The stub model follows a marker: it edits a file outside the plan (a scope breach).
        planSummary: stub ? '[stub:edit]' : task.title,
        specText: '',
        agentsMd: '',
        repoSource: { dir: base.repoDir, specPath: base.specPath },
        plannedFiles: task.plannedFiles,
        instructionsSha256: base.instructionsSha256,
        caps: { maxIterations: config.maxIterations, maxDurationMin: config.maxDurationMin },
        afterClaim: async (scope, envelope) => {
          if (stub || !controller) return;
          const issued = await controller.issueRunKey({
            tenantId: scope.tenantId,
            runId: envelope.contract.run_id,
            gate: 'G4',
            agent: 'coder-openhands',
          });
          keyId = issued.key.keyId;
          virtualKey = secret(issued.key.key.reveal());
        },
      });
      const runId = fixture.envelope.contract.run_id;
      const diffs: { path: string; content: Buffer }[] = [];
      try {
        const result = await driveAgent(
          {
            db: t.app as unknown as AgentDriveDeps['db'],
            docker: client,
            settings: fixture.settings,
            adapter: new OpenHandsAdapter({ requestTimeoutMs: 120_000 }),
            agentUrl: () => fixture.relayUrl,
            ...changesStep(t, client, fixture, diffs),
          },
          {
            contract: fixture.envelope.contract,
            sandbox: fixture.sandbox,
            model: config.model.name,
            virtualKey,
          },
        );
        const seconds = Math.round((Date.now() - started) / 1000);
        let records = await fixture.scope.costRecords.listForRun(runId);
        if (controller && keyId) {
          await controller.endRun({ keyId, syncFrom: new Date(started - 60_000) });
          for (let i = 0; i < 15 && records.length === 0; i++) {
            await new Promise((r) => setTimeout(r, 2000));
            await controller.syncSpend({
              from: new Date(started - 60_000),
              to: new Date(Date.now() + 60_000),
            });
            records = await fixture.scope.costRecords.listForRun(runId);
          }
        }
        const agentPatch = diffs.map((d) => d.content.toString('utf8')).join('');
        const score = await executor.score({ task, basePatch: base.basePatch, agentPatch });
        const changed = (result.outputs?.changedFiles ?? []).map((f) => f.path);
        const scope = policy.checkScope({
          plannedFiles: [...task.plannedFiles],
          changedFiles: changed,
        });
        const sum = (pick: (r: (typeof records)[number]) => string) =>
          records.reduce((n, r) => n + Number(pick(r)), 0);
        const costMicros = records.reduce((n, r) => n + toMicros(r.cost_usd), 0n);
        const run_ = await fixture.scope.runs.getById(runId);
        const file = writeRunResult(
          s!.out,
          buildRunResult({
            taskSet: set.version,
            task,
            configuration: config,
            run,
            instructionsSha256: base.instructionsSha256,
            agentPatch,
            score,
            measures: {
              outcome: result.outcome,
              status: run_?.status ?? result.status ?? 'unknown',
              stopReason: run_?.stop_reason ?? null,
              seconds,
              iterations: result.outputs?.iterations ?? 0,
              modelCalls: records.length,
              inputTokens: sum((r) => r.input_tokens),
              outputTokens: sum((r) => r.output_tokens),
              cachedInputTokens: sum((r) => r.cached_input_tokens),
              costUsd: formatUsd6(fromMicros(costMicros)),
              outOfPlanFiles: scope.outOfScope.length,
            },
            where: executor.where,
            hardware: await executor.hardware(),
          }),
        );
        // QUESTIONS #445: the diff stays on this machine for blind review (`pnpm eval:pairs`),
        // never in a result or the report; `pnpm eval:pairs purge-diffs` deletes it.
        writeDiff(
          s!.out,
          { taskSet: set.version, configuration: config.id, task: task.id, run },
          agentPatch,
        );
        process.stderr.write(
          `L02 RUN ${config.id} ${task.id} ${String(run)} → ${path.basename(file)}\n`,
        );
      } finally {
        await teardownSandbox(client, runId).catch(() => undefined);
        quietly('rm', '-f', fixture.relay);
        fs.rmSync(workDir, { recursive: true, force: true });
      }
    }

    it(
      'runs every configuration × task × run and writes one result per run',
      { timeout: 7 * 24 * 3_600_000 },
      async () => {
        let done = 0;
        for (const config of configurations) {
          for (const task of set.tasks) {
            for (let run = 1; run <= s!.runs; run++) {
              const key = { taskSet: set.version, configuration: config.id, task: task.id, run };
              if (hasRunResult(s!.out, key)) continue;
              await runOnce(config, task, run);
              done += 1;
            }
          }
        }
        process.stderr.write(`L02 DONE ${String(done)} new runs\n`);
        expect(done).toBeGreaterThanOrEqual(0);
      },
    );
  },
);
