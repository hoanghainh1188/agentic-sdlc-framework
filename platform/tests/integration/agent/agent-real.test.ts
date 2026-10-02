// ADR-M10 §3, QUESTIONS #78: the C05 real-model run. The runner drives the OpenHands Agent Server
// in a node24 sandbox; the agent calls a REAL model, a local Ollama `gpt-oss:20b`, through a real
// LiteLLM with a per-run virtual key from the Cost Controller (seven labels, budget cap). Spend is
// synced into `cost_records`.
//
// DEVELOPER MACHINES ONLY, never in CI: `pnpm test:agent-real` (SDLC_AGENT_REAL_TEST=1, throw-away
// PostgreSQL from test-db.sh). Needs Ollama on this machine with the local tag `gpt-oss:20b`
// (`ollama pull gpt-oss:20b`), reachable from Docker at host.docker.internal:11434.
// `SDLC_SANDBOX_IMAGE` (name@sha256:…) skips the node24 build. `SDLC_AGENT_REAL_REPORT` names a
// file that receives the numbers as JSON (time, calls, tokens, cost, peak memory).
//
// No secret is involved: Ollama has no key; the LiteLLM master and salt keys are random values of
// this test. The model entry is taken from the production template (config.ctmpl), so the run
// tests the entry that developer machines render.
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { OpenHandsAdapter } from '@sdlc/adapter-agent-openhands';
import { LiteLLMGateway } from '@sdlc/adapter-model-litellm';
import { Redacted } from '@sdlc/secrets';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DockerClient,
  driveAgent,
  Runner,
  teardownSandbox,
  type AgentDriveDeps,
} from '../../../apps/runner/src/index.js';
import { CostController } from '../../../packages/core/src/cost/index.js';
import { createTestDatabase, type TestDatabase } from '../db/helpers.js';
import { deployDir } from '../../deploy/compose';
import { docker, dockerSocket, quietly } from '../runner/live-helpers';
import { buildSandboxImage } from '../sandbox-image/helpers';
import { changesStep, startAgentRun } from './helpers';

const enabled = process.env.SDLC_AGENT_REAL_TEST === '1' && !!process.env.SDLC_TEST_DATABASE_URL;
const MODEL = 'gpt-oss-20b';
const OLLAMA_URL = process.env.SDLC_OLLAMA_URL ?? 'http://host.docker.internal:11434';
const RUN_TIMEOUT_MS = 30 * 60_000;
const suffix = crypto.randomBytes(4).toString('hex');
const names = {
  platformNet: `sdlc-c05r-platform-${suffix}`,
  litellm: `sdlc-c05r-litellm-${suffix}`,
  registry: `sdlc-c05r-registry-${suffix}`,
};

/** The Ollama model entry of the production template, with the address filled in. */
function ollamaEntry(): string {
  const template = fs.readFileSync(path.join(deployDir, 'litellm/config.ctmpl'), 'utf8');
  const match = /\n( {2}- model_name: gpt-oss-20b\n[\s\S]*?provider_type: self_hosted\n)/.exec(
    template,
  );
  if (!match) throw new Error('the Ollama entry is missing from config.ctmpl');
  return match[1]!.replace('{{ .Data.data.api_base | toJSON }}', JSON.stringify(OLLAMA_URL));
}

function litellmImage(): string {
  const compose = fs.readFileSync(path.join(deployDir, 'docker-compose.yml'), 'utf8');
  const image = /image: (ghcr\.io\/berriai\/litellm:\S+)/.exec(compose)?.[1];
  if (!image) throw new Error('LiteLLM image not found in docker-compose.yml');
  return image;
}

interface Peaks {
  ollamaRssMb: number;
  sandboxMb: number;
  litellmMb: number;
  minFreePercent: number;
  ollamaLoaded: string;
}

/** Samples memory every 2 s: Ollama processes on this machine, the containers, free memory. */
function startSampler(sandbox: string): { stop: () => Peaks } {
  const peaks: Peaks = {
    ollamaRssMb: 0,
    sandboxMb: 0,
    litellmMb: 0,
    minFreePercent: 100,
    ollamaLoaded: '',
  };
  const mib = (text: string): number => {
    const m = /([0-9.]+)\s*([KMG]i?B)/.exec(text);
    if (!m) return 0;
    const unit = m[2]!.startsWith('G') ? 1024 : m[2]!.startsWith('K') ? 1 / 1024 : 1;
    return Number(m[1]) * unit;
  };
  const sample = () => {
    try {
      const rss = execFileSync('ps', ['-axo', 'rss=,comm='], { encoding: 'utf8' })
        .split('\n')
        .filter((l) => /ollama/.test(l))
        .reduce((sum, l) => sum + Number(l.trim().split(/\s+/)[0] ?? 0), 0);
      peaks.ollamaRssMb = Math.max(peaks.ollamaRssMb, Math.round(rss / 1024));
      const stats = docker('stats', '--no-stream', '--format', '{{.Name}} {{.MemUsage}}');
      for (const line of stats.split('\n')) {
        if (line.startsWith(`${sandbox} `))
          peaks.sandboxMb = Math.max(peaks.sandboxMb, Math.round(mib(line)));
        if (line.startsWith(`${names.litellm} `))
          peaks.litellmMb = Math.max(peaks.litellmMb, Math.round(mib(line)));
      }
      const free = /free percentage: ([0-9]+)%/.exec(
        execFileSync('memory_pressure', [], { encoding: 'utf8' }),
      )?.[1];
      if (free) peaks.minFreePercent = Math.min(peaks.minFreePercent, Number(free));
      const loaded = execFileSync('ollama', ['ps'], { encoding: 'utf8' }).split('\n')[1];
      if (loaded?.trim()) peaks.ollamaLoaded = loaded.replace(/\s+/g, ' ').trim();
    } catch {
      // sampling is best effort
    }
  };
  sample();
  const timer = setInterval(sample, 2000);
  return {
    stop: () => {
      clearInterval(timer);
      sample();
      return peaks;
    },
  };
}

describe.skipIf(!enabled)('C05 real-model run: gpt-oss:20b through LiteLLM (ADR-M10 §3)', () => {
  let t: TestDatabase;
  let image: string;
  let client: DockerClient;
  let controller: CostController;
  let gateway: LiteLLMGateway;
  let litellmDb = '';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-c05-real-'));
  const masterKey = `sk-c05r-${crypto.randomBytes(16).toString('hex')}`;

  const admin = async (sql: string) => {
    const c = new pg.Client({ connectionString: process.env.SDLC_TEST_DATABASE_URL });
    await c.connect();
    try {
      await c.query(sql);
    } finally {
      await c.end();
    }
  };

  beforeAll(async () => {
    t = await createTestDatabase();
    image = process.env.SDLC_SANDBOX_IMAGE || (await buildSandboxImage(names.registry));
    client = new DockerClient({ socketPath: dockerSocket(), timeoutMs: 120_000 });

    // LiteLLM's own database on the test server, reached from the container through the host.
    litellmDb = `litellm_c05r_${suffix}`;
    await admin(`CREATE DATABASE ${litellmDb}`);
    const dbUrl = new URL(process.env.SDLC_TEST_DATABASE_URL!);
    dbUrl.hostname = 'host.docker.internal';
    dbUrl.pathname = `/${litellmDb}`;

    const config = path.join(tmp, 'config.yaml');
    fs.writeFileSync(
      config,
      `model_list:\n${ollamaEntry()}\ngeneral_settings:\n  master_key: os.environ/LITELLM_MASTER_KEY\n  database_url: os.environ/DATABASE_URL\n`,
      { mode: 0o644 },
    );
    docker('network', 'create', names.platformNet);
    docker(
      'run',
      '-d',
      '--name',
      names.litellm,
      '--network',
      names.platformNet,
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
      const ready = await fetch(`${baseUrl}/health/readiness`)
        .then((r) => r.ok)
        .catch(() => false);
      if (ready) break;
      if (i > 150) throw new Error('LiteLLM did not become ready');
      await new Promise((r) => setTimeout(r, 2000));
    }
    gateway = new LiteLLMGateway({
      baseUrl,
      masterKey: new Redacted(masterKey),
      timeoutMs: 60_000,
    });
    controller = new CostController({
      gateway,
      db: t.app,
    });
  }, 1_800_000);

  afterAll(async () => {
    quietly('rm', '-f', '-v', names.litellm, names.registry);
    quietly('network', 'rm', names.platformNet);
    fs.rmSync(tmp, { recursive: true, force: true });
    if (litellmDb)
      await admin(`DROP DATABASE IF EXISTS ${litellmDb} WITH (FORCE)`).catch(() => undefined);
    await t?.drop();
  }, 120_000);

  it(
    'the agent writes hello.txt with gpt-oss:20b and finishes; spend within the cap',
    { timeout: RUN_TIMEOUT_MS + 10 * 60_000 },
    async () => {
      expect(await gateway.listModels()).toContainEqual({
        model: MODEL,
        providerType: 'self_hosted',
      });

      let keyId = '';
      let virtualKey: Redacted | undefined;
      let cap = '';
      const run = await startAgentRun({
        t,
        client,
        image,
        tmp,
        suffix,
        slug: 'c05-real',
        litellmContainer: names.litellm,
        model: MODEL,
        planSummary: 'Create the file hello.txt in the repository root, as the specification says.',
        specText:
          '# T01 Hello file\n\n## Acceptance criteria\n\n- AC1: the file `hello.txt` exists in the repository root.\n- AC2: its content is exactly one line: `Hello from the platform.`\n',
        agentsMd:
          '# Agent instructions\n\n- Keep changes small. Do not install dependencies for this task.\n',
        caps: { maxIterations: 30, maxDurationMin: 20 },
        afterClaim: async (scope, envelope) => {
          // Budget: min(budget.default_run_usd, 1.00) = the contract's max_budget_usd (1).
          const issued = await controller.issueRunKey({
            tenantId: scope.tenantId,
            runId: envelope.contract.run_id,
            gate: 'G4',
            agent: 'coder-openhands',
          });
          keyId = issued.key.keyId;
          virtualKey = new Redacted(issued.key.key.reveal());
          cap = issued.maxBudgetUsd;
        },
      });
      const runId = run.envelope.contract.run_id;
      const sampler = startSampler(run.sandbox.names.container);
      const started = Date.now();
      try {
        const runner = new Runner(
          {
            db: t.app as unknown as AgentDriveDeps['db'],
            docker: client,
            settings: run.settings,
            verifier: {
              verify: () => Promise.resolve(false),
              publicKey: () => Promise.reject(new Error('unused')),
            },
            unwrapper: { unwrap: () => Promise.reject(new Error('unused')) },
          },
          {},
          {
            adapter: new OpenHandsAdapter({ requestTimeoutMs: 60_000 }),
            agentUrl: () => run.relayUrl,
          },
        );
        // The runner did not provision this fixture run, so it holds no clone: drive the agent
        // with the fixture's clone (C07 changes step), then release the run through the runner.
        const result = await driveAgent(
          {
            db: t.app as unknown as AgentDriveDeps['db'],
            docker: client,
            settings: run.settings,
            adapter: new OpenHandsAdapter({ requestTimeoutMs: 60_000 }),
            agentUrl: () => run.relayUrl,
            ...changesStep(t, client, run, []),
          },
          {
            contract: run.envelope.contract,
            sandbox: run.sandbox,
            model: MODEL,
            virtualKey: virtualKey!,
          },
        ).finally(() => runner.release(run.envelope.contract.tenant_id, runId, 'finished'));
        const seconds = Math.round((Date.now() - started) / 1000);
        const peaks = sampler.stop();

        // End of run: revoke the key, then sync spend until the calls are in cost_records.
        await controller.endRun({ keyId, syncFrom: new Date(started - 60_000) });
        let records = await run.scope.costRecords.listForRun(runId);
        for (let i = 0; i < 30 && records.length === 0; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          await controller.syncSpend({
            from: new Date(started - 60_000),
            to: new Date(Date.now() + 60_000),
          });
          records = await run.scope.costRecords.listForRun(runId);
        }
        const tokensIn = records.reduce((s, r) => s + Number(r.input_tokens), 0);
        const tokensOut = records.reduce((s, r) => s + Number(r.output_tokens), 0);
        const cost = records.reduce((s, r) => s + Number(r.cost_usd), 0);
        const events = result.outputs?.events ?? [];
        const report = {
          model: 'gpt-oss:20b (Ollama 0.34.4, local, reasoning_effort low, num_ctx 32768)',
          outcome: result.outcome,
          status: result.status,
          seconds,
          iterations: result.outputs?.iterations,
          model_calls: records.length,
          tokens_in: tokensIn,
          tokens_out: tokensOut,
          cost_usd: cost.toFixed(6),
          cap_usd: cap,
          changed_files: result.outputs?.changedFiles,
          agent_messages: events.filter((e) => e.kind === 'MessageEvent').length,
          errors: events.filter((e) => e.kind === 'ConversationErrorEvent').map((e) => e.code),
          peak_ollama_rss_mb: peaks.ollamaRssMb,
          ollama_loaded: peaks.ollamaLoaded,
          peak_sandbox_mb: peaks.sandboxMb,
          peak_litellm_mb: peaks.litellmMb,
          min_free_memory_percent: peaks.minFreePercent,
        };
        process.stderr.write(`C05 REAL RUN ${JSON.stringify(report)}\n`);
        if (process.env.SDLC_AGENT_REAL_REPORT) {
          fs.writeFileSync(process.env.SDLC_AGENT_REAL_REPORT, JSON.stringify(report, null, 2));
        }

        // Pass criteria (ADR-M10 §3).
        expect(result).toMatchObject({ outcome: 'finished', status: 'succeeded' });
        expect(result.outputs?.changedFiles).toContainEqual({ path: 'hello.txt', status: 'added' });
        expect(records.length).toBeGreaterThan(0);
        expect(cost).toBeLessThanOrEqual(Number(cap));
        for (const r of records) expect(r.model).toBe(MODEL);
        // The key is revoked: LiteLLM refuses it now.
        const after = await fetch(
          `${new URL(docker('port', names.litellm, '4000/tcp').split('\n')[0]!.replace(/^/, 'http://')).origin}/v1/chat/completions`,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${virtualKey!.reveal()}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] }),
          },
        );
        expect(after.status).toBe(401);
      } finally {
        sampler.stop();
        await teardownSandbox(client, runId).catch(() => undefined);
        quietly('rm', '-f', run.relay);
      }
    },
  );
});
