// X01 spike (design/ADR-M68): Aider and OpenCode in the node24 sandbox, driven by the platform's
// own runner code (`startAgentRun` → `createSandbox` with the guard, `driveAgent` with its caps,
// interrupt, loop watch, commit and changes step) through the two spike adapters. Thrown away.
//
// DEVELOPER MACHINE ONLY, never in CI: `platform/spikes/agent2/run.sh` (a throw-away PostgreSQL).
// Needs Docker, the images of build.sh, Ollama with `gpt-oss:20b`. No secret: Ollama has no key;
// the LiteLLM keys are random values of this run. Results (numbers and codes only) go to X01_OUT,
// outside the repository.
//
// X01_MODE:
// - `checks` (AC1): egress probe, the agent's environment, the iteration cap, a stop on request
//   and the time cap, for each agent.
// - `compare` (AC2): every agent × task × run on the eval task set v1, scored like `pnpm eval`.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AgentAdapter, AgentRunHandle, AgentRunStatus } from '@sdlc/contracts';
import { LiteLLMGateway } from '@sdlc/adapter-model-litellm';
import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';
import { loadProjectConfig } from '@sdlc/config';
import { Redacted } from '@sdlc/secrets';
import {
  ensureClone,
  litellmModelList,
  loadTaskSet,
  LocalExecutor,
  prepareBase,
  type EvalConfiguration,
  type EvalTask,
  type TaskSet,
} from '@sdlc/eval';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DockerClient,
  driveAgent,
  teardownSandbox,
  type AgentDriveDeps,
} from '../../apps/runner/src/index.js';
import { CostController } from '../../packages/core/src/cost/index.js';
import { fromMicros, toMicros } from '../../packages/core/src/cost/money.js';
import { formatUsd6 } from '../../packages/core/src/cost/report.js';
import { changesStep, secret, startAgentRun } from '../../tests/integration/agent/helpers';
import { createTestDatabase, type TestDatabase } from '../../tests/integration/db/helpers.js';
import { deployDir } from '../../tests/deploy/compose';
import { docker, dockerSocket, quietly } from '../../tests/integration/runner/live-helpers';
import { VERDACCIO } from '../../tests/integration/sandbox-image/helpers';
import { repoRoot } from '../../tests/workspace/helpers';
import { AiderAdapter } from './src/aider-adapter.js';
import { call } from './src/common.js';
import { adapterCapStops, OpenCodeAdapter, wrapped } from './src/opencode-adapter.js';

const enabled = process.env.X01 === '1' && !!process.env.SDLC_TEST_DATABASE_URL;
const MODE = process.env.X01_MODE === 'checks' ? 'checks' : 'compare';
const OUT = process.env.X01_OUT ?? '';
const AGENTS = (process.env.X01_AGENTS ?? 'opencode,aider').split(',') as AgentName[];
const RUNS = Number(process.env.X01_N ?? '2');
const OLLAMA_URL = 'http://host.docker.internal:11434';
const MODEL = 'gpt-oss-20b';
const CONTEXT_TOKENS = 32768;
/** The project's check command, which Aider needs from the platform (`--test-cmd`). */
const AIDER_TEST_CMD =
  'pnpm install --frozen-lockfile --prefer-offline >/dev/null 2>&1; pnpm --filter @pilot/api test';
const suffix = crypto.randomBytes(4).toString('hex');
const names = {
  net: `x01-platform-${suffix}`,
  litellm: `x01-litellm-${suffix}`,
  npm: `x01-npm-${suffix}`,
};
const NPM_CACHE_VOLUME = 'sdlc-eval-npm-cache';

type AgentName = 'aider' | 'opencode';

const configuration: EvalConfiguration = {
  id: MODEL,
  agentVersion: '0.0.0',
  model: {
    provider: 'ollama',
    name: MODEL,
    tag: 'gpt-oss:20b',
    numCtx: CONTEXT_TOKENS,
    reasoningEffort: 'low',
  },
  instructions: 'repo',
  instructionsText: null,
  instructionsSha256: null,
  maxIterations: 30,
  maxDurationMin: 20,
};

function image(agent: AgentName): string {
  const ref = process.env[`X01_IMAGE_${agent.toUpperCase()}`] ?? '';
  if (!/@sha256:[0-9a-f]{64}$/.test(ref))
    throw new Error(`X01_IMAGE_${agent.toUpperCase()}: by digest`);
  return ref;
}

function adapterOf(agent: AgentName): AgentAdapter {
  return agent === 'aider'
    ? new AiderAdapter({ testCmd: AIDER_TEST_CMD, contextTokens: CONTEXT_TOKENS })
    : new OpenCodeAdapter();
}

/** Wraps an adapter to record how it reports progress: counts and times only. */
function observed(inner: AgentAdapter, stopAfterSeconds?: number) {
  const log = {
    polls: 0,
    firstProgressSeconds: null as number | null,
    maxEvents: 0,
    maxIdentical: 0,
    states: [] as string[],
    stopCalls: 0,
    stopToEndSeconds: null as number | null,
  };
  const started = Date.now();
  let stopAt = 0;
  const adapter: AgentAdapter = {
    startRun: (i) => inner.startRun(i),
    getStatus: async (h: AgentRunHandle): Promise<AgentRunStatus> => {
      let s = await inner.getStatus(h);
      log.polls += 1;
      // A stop on request (what the kill switch's interrupt does), once, after a fixed time.
      if (
        stopAfterSeconds !== undefined &&
        log.stopCalls === 0 &&
        s.state === 'running' &&
        Date.now() - started >= stopAfterSeconds * 1000
      ) {
        log.stopCalls += 1;
        stopAt = Date.now();
        await inner.stop(h);
        s = await inner.getStatus(h);
      }
      if (s.events > 0 && log.firstProgressSeconds === null) {
        log.firstProgressSeconds = Math.round((Date.now() - started) / 1000);
      }
      log.maxEvents = Math.max(log.maxEvents, s.events);
      log.maxIdentical = Math.max(log.maxIdentical, s.identicalCalls);
      if (log.states.at(-1) !== s.state) log.states.push(s.state);
      if (stopAt && s.state !== 'running' && log.stopToEndSeconds === null) {
        log.stopToEndSeconds = Math.round((Date.now() - stopAt) / 1000);
      }
      return s;
    },
    stop: async (h) => {
      log.stopCalls += 1;
      stopAt = Date.now();
      await inner.stop(h);
    },
    commitWork: (h, i) => inner.commitWork(h, i),
    collectOutputs: (h, b) => inner.collectOutputs(h, b),
  };
  return { adapter, log };
}

function litellmImage(): string {
  const compose = fs.readFileSync(path.join(deployDir, 'docker-compose.yml'), 'utf8');
  const ref = /image: (ghcr\.io\/berriai\/litellm:\S+)/.exec(compose)?.[1];
  if (!ref) throw new Error('LiteLLM image not found in docker-compose.yml');
  return ref;
}

const policy = (() => {
  const loaded = loadProjectConfig('');
  if (!loaded.ok) throw new Error('default configuration refused');
  return createSimplePolicyEngine({ config: loaded.config });
})();

/** Egress and environment probe, run with the agent's own shell inside the sandbox. */
const PROBE = String.raw`
p(){ if curl -s -m 5 -o /dev/null "$1"; then echo "PROBE $2 open"; else echo "PROBE $2 blocked"; fi; }
p http://litellm:4000/health/liveliness litellm
p http://npm-proxy:4873/-/ping npm-proxy
p https://github.com github
p https://api.github.com api-github
p http://1.1.1.1 ip-1.1.1.1
p http://host.docker.internal:11434/api/tags ollama-host
p https://registry.npmjs.org npm-registry
p https://pypi.org pypi
p https://openaipublic.blob.core.windows.net tiktoken-host
p https://huggingface.co huggingface
p https://opencode.ai opencode-site
p https://models.dev models-dev
p https://us.i.posthog.com posthog
if getent hosts github.com >/dev/null 2>&1; then echo "PROBE dns-external open"; else echo "PROBE dns-external blocked"; fi
cd /workspace
/usr/bin/git -c credential.helper= push --dry-run https://github.com/harryforge/pilot-order-inventory.git HEAD:refs/heads/x01-probe >/dev/null 2>&1 && echo "PROBE git-push open" || echo "PROBE git-push blocked"
for v in SESSION_API_KEY OH_SECRET_KEY OPENCODE_SERVER_PASSWORD OPENAI_API_KEY; do
  if printenv "$v" >/dev/null; then echo "PROBE env-$v visible"; else echo "PROBE env-$v absent"; fi
done
if [ -e "$HOME/.local/share/opencode/auth.json" ]; then echo "PROBE key-file present"; else echo "PROBE key-file absent"; fi
`;

describe.skipIf(!enabled)('X01: a second agent in the node24 sandbox', () => {
  let t: TestDatabase;
  let set: TaskSet;
  let clone: string;
  let client: DockerClient;
  let controller: CostController;
  let executor: LocalExecutor;
  let litellmDb = '';
  let litellmUrl = '';
  let tenants = 0;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'x01-'));
  const masterKey = `sk-x01-${crypto.randomBytes(16).toString('hex')}`;

  const admin = async (sql: string) => {
    const c = new pg.Client({ connectionString: process.env.SDLC_TEST_DATABASE_URL });
    await c.connect();
    try {
      await c.query(sql);
    } finally {
      await c.end();
    }
  };

  function write(name: string, value: unknown): void {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, name), `${JSON.stringify(value, null, 2)}\n`);
    process.stderr.write(`X01 ${name}\n`);
  }

  beforeAll(async () => {
    if (!path.isAbsolute(OUT) || !path.relative(repoRoot(), OUT).startsWith('..')) {
      throw new Error('X01_OUT must be an absolute folder outside the repository');
    }
    set = loadTaskSet(path.join(repoRoot(), 'platform/eval/tasks/v1'), [
      'feat-sku-rule',
      'bug-order-number',
    ]);
    clone = ensureClone(path.join(os.homedir(), '.cache', 'sdlc-eval'), set);
    t = await createTestDatabase();
    client = new DockerClient({ socketPath: dockerSocket(), timeoutMs: 900_000 });
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
    executor = new LocalExecutor({
      image: process.env.X01_IMAGE_NODE24 ?? '',
      cloneDir: clone,
      commit: set.commit,
      proxyContainer: names.npm,
      proxyUrl: `http://${names.npm}:4873`,
    });
    litellmDb = `litellm_x01_${suffix}`;
    await admin(`CREATE DATABASE ${litellmDb}`);
    const dbUrl = new URL(process.env.SDLC_TEST_DATABASE_URL!);
    dbUrl.hostname = 'host.docker.internal';
    dbUrl.pathname = `/${litellmDb}`;
    const config = path.join(tmp, 'litellm.yaml');
    fs.writeFileSync(
      config,
      `${litellmModelList([configuration], OLLAMA_URL)}general_settings:\n  master_key: os.environ/LITELLM_MASTER_KEY\n  database_url: os.environ/DATABASE_URL\n`,
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
    litellmUrl = `http://127.0.0.1:${port}`;
    for (let i = 0; ; i++) {
      if (
        await fetch(`${litellmUrl}/health/readiness`)
          .then((r) => r.ok)
          .catch(() => false)
      )
        break;
      if (i > 150) throw new Error('LiteLLM did not become ready');
      await new Promise((r) => setTimeout(r, 2000));
    }
    const gateway = new LiteLLMGateway({
      baseUrl: litellmUrl,
      masterKey: new Redacted(masterKey),
      timeoutMs: 60_000,
    });
    controller = new CostController({ gateway, db: t.app });
  }, 3_600_000);

  afterAll(async () => {
    quietly('rm', '-f', '-v', names.litellm);
    quietly('rm', '-f', names.npm);
    quietly('network', 'rm', names.net);
    fs.rmSync(tmp, { recursive: true, force: true });
    if (litellmDb)
      await admin(`DROP DATABASE IF EXISTS ${litellmDb} WITH (FORCE)`).catch(() => undefined);
    await t?.drop();
  }, 300_000);

  interface Caps {
    readonly maxIterations: number;
    readonly maxDurationMin: number;
  }

  /** One run: a sandbox from the agent's image, the platform's driver, then the scoring. */
  async function runOnce(input: {
    agent: AgentName;
    task: EvalTask;
    caps: Caps;
    label: string;
    score: boolean;
    stopAfterSeconds?: number;
  }) {
    const workDir = fs.mkdtempSync(path.join(tmp, `${input.task.id}-`));
    const base = prepareBase({
      clone,
      commit: set.commit,
      task: input.task,
      instructionsText: null,
      workDir,
    });
    let keyId = '';
    let virtualKey = secret('none');
    const started = Date.now();
    const fixture = await startAgentRun({
      t,
      client,
      image: image(input.agent),
      tmp: workDir,
      suffix,
      slug: `x01-${String(++tenants)}`,
      litellmContainer: names.litellm,
      npmProxyContainer: names.npm,
      model: MODEL,
      planSummary: input.task.title,
      specText: '',
      agentsMd: '',
      repoSource: { dir: base.repoDir, specPath: base.specPath },
      plannedFiles: input.task.plannedFiles,
      instructionsSha256: base.instructionsSha256,
      caps: input.caps,
      afterClaim: async (scope, envelope) => {
        const issued = await controller.issueRunKey({
          tenantId: scope.tenantId,
          runId: envelope.contract.run_id,
          gate: 'G4',
          agent: `coder-${input.agent}`,
        });
        keyId = issued.key.keyId;
        virtualKey = secret(issued.key.key.reveal());
      },
    });
    const runId = fixture.envelope.contract.run_id;
    const diffs: { path: string; content: Buffer }[] = [];
    const { adapter, log } = observed(adapterOf(input.agent), input.stopAfterSeconds);
    try {
      const result = await driveAgent(
        {
          db: t.app as unknown as AgentDriveDeps['db'],
          docker: client,
          settings: fixture.settings,
          adapter,
          agentUrl: () => fixture.relayUrl,
          ...changesStep(t, client, fixture, diffs),
        },
        { contract: fixture.envelope.contract, sandbox: fixture.sandbox, model: MODEL, virtualKey },
      );
      const seconds = Math.round((Date.now() - started) / 1000);
      await controller.endRun({ keyId, syncFrom: new Date(started - 60_000) });
      let records = await fixture.scope.costRecords.listForRun(runId);
      for (let i = 0; i < 15 && records.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        await controller.syncSpend({
          from: new Date(started - 60_000),
          to: new Date(Date.now() + 60_000),
        });
        records = await fixture.scope.costRecords.listForRun(runId);
      }
      const agentPatch = diffs.map((d) => d.content.toString('utf8')).join('');
      const score = input.score
        ? await executor.score({ task: input.task, basePatch: base.basePatch, agentPatch })
        : null;
      const changed = (result.outputs?.changedFiles ?? []).map((f) => f.path);
      const scope = policy.checkScope({
        plannedFiles: [...input.task.plannedFiles],
        changedFiles: changed,
      });
      const run = await fixture.scope.runs.getById(runId);
      const events = await fixture.scope.runEvents.list(runId);
      const sum = (pick: (r: (typeof records)[number]) => string) =>
        records.reduce((n, r) => n + Number(pick(r)), 0);
      const summary = {
        agent: input.agent,
        label: input.label,
        task: input.task.id,
        model: MODEL,
        caps: input.caps,
        outcome: result.outcome,
        status: run?.status ?? null,
        stopReason: run?.stop_reason ?? null,
        seconds,
        iterations: result.outputs?.iterations ?? run?.iterations ?? 0,
        modelCalls: records.length,
        inputTokens: sum((r) => r.input_tokens),
        outputTokens: sum((r) => r.output_tokens),
        cachedInputTokens: sum((r) => r.cached_input_tokens),
        costUsd: formatUsd6(fromMicros(records.reduce((n, r) => n + toMicros(r.cost_usd), 0n))),
        changedFiles: changed.length,
        outOfPlanFiles: scope.outOfScope.length,
        // Raw results only (X01_OUT); summarise.mjs never copies paths into results/.
        outOfPlanPaths: scope.outOfScope,
        diffLines: agentPatch.split('\n').filter((l) => /^[+-][^+-]/.test(l)).length,
        score,
        progress: log,
        adapterCapStop: adapterCapStops.has(runId),
        runEvents: events.map((e) => e.event_type),
      };
      return summary;
    } finally {
      await teardownSandbox(client, runId).catch(() => undefined);
      quietly('rm', '-f', fixture.relay);
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }

  /** The probe through the agent's own shell, in a fresh sandbox with no model call. */
  async function probe(agent: AgentName): Promise<Record<string, string>> {
    const task = set.tasks[0]!;
    const workDir = fs.mkdtempSync(path.join(tmp, 'probe-'));
    const base = prepareBase({ clone, commit: set.commit, task, instructionsText: null, workDir });
    const fixture = await startAgentRun({
      t,
      client,
      image: image(agent),
      tmp: workDir,
      suffix,
      slug: `x01-${String(++tenants)}`,
      litellmContainer: names.litellm,
      npmProxyContainer: names.npm,
      model: MODEL,
      planSummary: task.title,
      specText: '',
      agentsMd: '',
      repoSource: { dir: base.repoDir, specPath: base.specPath },
      plannedFiles: task.plannedFiles,
      instructionsSha256: base.instructionsSha256,
      caps: { maxIterations: 1, maxDurationMin: 5 },
    });
    // The runner joins the run's network (here: the relay), as in driveAgent.
    docker('network', 'connect', fixture.sandbox.names.network, fixture.relay);
    const key = fixture.sandbox.sessionApiKey;
    try {
      let out = '';
      if (agent === 'aider') {
        const http = {
          baseUrl: fixture.relayUrl,
          authorization: `Bearer ${key}`,
          timeoutMs: 300_000,
        };
        out = (await call<{ stdout: string }>(http, 'POST', '/bash', { command: PROBE })).stdout;
      } else {
        const basic = Buffer.from(`opencode:${key}`).toString('base64');
        const http = {
          baseUrl: fixture.relayUrl,
          authorization: `Basic ${basic}`,
          timeoutMs: 300_000,
        };
        // A key set as the run would set it, to see where OpenCode keeps it.
        await call(http, 'PUT', '/auth/litellm', { type: 'api', key: 'sk-x01-probe-not-a-key' });
        const session = await call<{ id: string }>(http, 'POST', '/session', {});
        const m = await call<{ parts: { type: string; state?: { output?: string } }[] }>(
          http,
          'POST',
          `/session/${session.id}/shell`,
          { agent: 'build', command: wrapped(PROBE) },
        );
        out = m.parts.find((p) => p.type === 'tool')?.state?.output ?? '';
      }
      const unauth = await fetch(`${fixture.relayUrl}/${agent === 'aider' ? 'status' : 'session'}`);
      const result: Record<string, string> = { 'api-without-key': String(unauth.status) };
      for (const line of out.split('\n')) {
        const m = /^PROBE (\S+) (\S+)$/.exec(line.trim());
        if (m) result[m[1]!] = m[2]!;
      }
      return result;
    } finally {
      await teardownSandbox(client, fixture.envelope.contract.run_id).catch(() => undefined);
      quietly('rm', '-f', fixture.relay);
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }

  it.skipIf(MODE !== 'checks')(
    'AC1: egress, environment, caps and stop',
    { timeout: 6 * 3_600_000 },
    async () => {
      const task = set.tasks.find((x) => x.id === 'feat-sku-rule')!;
      for (const agent of AGENTS) {
        const only = (process.env.X01_CHECKS ?? 'probe,cap,time,stop').split(',');
        if (only.includes('probe')) {
          const probed = await probe(agent);
          write(`checks-${agent}-probe.json`, probed);
          expect(probed.litellm).toBe('open');
          for (const k of [
            'github',
            'ip-1.1.1.1',
            'ollama-host',
            'npm-registry',
            'git-push',
            'dns-external',
          ]) {
            expect(probed[k], `${agent} ${k}`).toBe('blocked');
          }
          expect(probed['api-without-key']).toBe('401');
        }
        const checks: { name: string; caps: Caps; stopAfterSeconds?: number }[] = [
          { name: 'cap', caps: { maxIterations: agent === 'aider' ? 1 : 2, maxDurationMin: 15 } },
          { name: 'time', caps: { maxIterations: 200, maxDurationMin: 1 } },
          { name: 'stop', caps: { maxIterations: 200, maxDurationMin: 15 }, stopAfterSeconds: 8 },
        ];
        for (const c of checks.filter((x) => only.includes(x.name))) {
          const r = await runOnce({
            agent,
            task,
            caps: c.caps,
            label: c.name,
            score: false,
            stopAfterSeconds: c.stopAfterSeconds,
          });
          write(`checks-${agent}-${c.name}.json`, r);
        }
      }
    },
  );

  it.skipIf(MODE !== 'compare')(
    'AC2: agents × tasks × runs on the same model',
    { timeout: 7 * 24 * 3_600_000 },
    async () => {
      for (const agent of AGENTS) {
        for (const task of set.tasks) {
          for (let run = 1; run <= RUNS; run++) {
            const file = `compare-${agent}-${task.id}-${String(run)}.json`;
            if (fs.existsSync(path.join(OUT, file))) continue;
            const r = await runOnce({
              agent,
              task,
              caps: {
                maxIterations: configuration.maxIterations,
                maxDurationMin: configuration.maxDurationMin,
              },
              label: 'compare',
              score: true,
            });
            write(file, r);
          }
        }
      }
    },
  );
});
