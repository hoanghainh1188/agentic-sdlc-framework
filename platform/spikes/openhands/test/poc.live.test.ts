// C01 live PoC against a real OpenHands Agent Server container (design/ADR-M10).
// Skipped unless SDLC_OPENHANDS_POC=1. Needs the core stack plus the spike override (README.md):
// LiteLLM with litellm.poc.yaml, the stub model, and the internal network `sdlc-poc-sandbox`.
// Writes a JSON report (SDLC_POC_REPORT, default in the OS temp dir) used to fill ADR-M10.
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readEnvFile, requireValue } from '../src/env-file.ts';
import { COST_LABEL_NAMES, LiteLlmAdmin } from '../src/litellm-admin.ts';
import { PocRun, WORKING_DIR } from '../src/poc-run.ts';
import {
  containerEnv,
  containerExists,
  docker,
  inspect,
  listeningSockets,
  sampleStats,
  SANDBOX_NETWORK,
} from '../src/sandbox.ts';
import { loadSpikeSettings, realRunBudgetUsd } from '../src/spike-settings.ts';
import { toRunStatus } from '../src/status-map.ts';
import { POC_FILE_NAME } from '../src/stub-script.ts';

const LIVE = process.env['SDLC_OPENHANDS_POC'] === '1';
const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');
const ENV_FILE =
  process.env['SDLC_DEPLOY_ENV_FILE'] ?? path.join(REPO_ROOT, 'platform/deploy/.env');
const REPORT = process.env['SDLC_POC_REPORT'] ?? path.join(tmpdir(), 'c01-poc-report.json');

const report: Record<string, unknown> = { image: 'agent-server:1.48.0-python-slim' };
const settings = loadSpikeSettings();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Short, secret-free view of the event log for the report: kind, source, tool, first chars. */
function timeline(events: readonly Record<string, unknown>[]): string[] {
  const str = (value: unknown) => (typeof value === 'string' ? value : '');
  return events.map((e) => {
    const detail = JSON.stringify(
      e['observation'] ?? e['action'] ?? e['error'] ?? e['value'] ?? '',
    );
    return `${str(e['kind'])} ${str(e['source'])} ${str(e['tool_name'])} ${detail.slice(0, 160)}`;
  });
}

async function waitForSpendLogs(admin: LiteLlmAdmin, key: string, min: number) {
  for (let i = 0; i < 30; i += 1) {
    const logs = await admin.spendLogs(key);
    if (logs.length >= min) return logs;
    await sleep(2_000);
  }
  return admin.spendLogs(key);
}

describe.skipIf(!LIVE)('C01 live: OpenHands Agent Server controlled from Node.js', () => {
  let admin: LiteLlmAdmin;
  let litellmUrl: string;
  let realKeyConfigured = false;
  const runs: PocRun[] = [];

  beforeAll(() => {
    const env = readEnvFile(ENV_FILE);
    litellmUrl = `http://127.0.0.1:${env.get('LITELLM_HOST_PORT') || '4000'}`;
    admin = new LiteLlmAdmin(litellmUrl, requireValue(env, 'LITELLM_MASTER_KEY'));
    realKeyConfigured = Boolean(env.get('POC_ANTHROPIC_API_KEY'));
  });

  afterAll(async () => {
    await Promise.all(runs.map((r) => r.cleanup()));
    writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
  });

  function newRun(modelAlias: string, budgetUsd: number, stuckDetection = true): PocRun {
    const run = new PocRun({
      admin,
      settings,
      modelAlias,
      budgetUsd,
      readOnlyRoot: true,
      stuckDetection,
    });
    runs.push(run);
    return run;
  }

  it('AC1 + AC2: stub run — start, status, logs, changed files, labels, isolation', async () => {
    const t0 = Date.now();
    const run = await newRun('poc-stub', settings.defaultRunBudgetUsd).start();
    const startupMs = Date.now() - t0;
    const idle = await sampleStats(run.sandboxName);
    await run.startTask('[poc:edit] Create the PoC file, then finish.');
    const result = await run.waitForEnd(120_000);
    const busy = await sampleStats(run.sandboxName);

    // AC1: status, logs, changed files, last commit.
    expect(result.status).toBe('finished');
    expect(toRunStatus(result.status, {})).toBe('succeeded');
    const kinds = new Set(result.events.map((e) => e.kind));
    expect(kinds).toContain('ActionEvent');
    expect(kinds).toContain('ObservationEvent');
    const changes = await run.client.gitChanges(WORKING_DIR);
    expect(changes).toContainEqual({ path: POC_FILE_NAME, status: 'ADDED' });
    const commits = await run.client.gitCommits(WORKING_DIR);
    expect(commits[0]?.subject).toBe('fixture: initial commit');

    // AC2: every model call went through LiteLLM with the run's virtual key and all 7 labels.
    const logs = await waitForSpendLogs(admin, run.virtualKey, 2);
    expect(logs.length).toBeGreaterThanOrEqual(2);
    const info = await admin.keyInfo(run.virtualKey);
    for (const label of COST_LABEL_NAMES) expect(info.metadata[label]).toBe(run.labels[label]);
    expect(info.models).toEqual(['poc-stub']);

    // FR-33 / sandbox isolation: no provider or master key, no OpenBao, internal network only.
    const inspection = await inspect(run.sandboxName);
    const env = containerEnv(inspection).join('\n');
    expect(env).not.toMatch(/ANTHROPIC|OPENAI|LITELLM_MASTER|VAULT_|BAO_|sk-ant-/i);
    expect(env).not.toContain(run.virtualKey);
    const networks = Object.keys(
      (inspection['NetworkSettings'] as { Networks: Record<string, unknown> }).Networks,
    );
    expect(networks).toEqual([SANDBOX_NETWORK]);
    expect(await docker(['network', 'inspect', SANDBOX_NETWORK, '--format', '{{.Internal}}'])).toBe(
      'true',
    );
    const host = inspection['HostConfig'] as Record<string, unknown>;
    expect(host['CapDrop']).toEqual(['ALL']);
    expect(host['ReadonlyRootfs']).toBe(true);
    expect(host['PortBindings'] ?? {}).toEqual({});
    const noInternet = await run.client.executeBash(
      'curl -sS -m 5 -o /dev/null https://api.github.com && echo reachable || echo blocked',
      '/workspace',
    );
    expect(noInternet.stdout ?? '').toContain('blocked');

    const sockets = await listeningSockets(run.sandboxName);
    const serverInfo = await run.client.serverInfo();
    report['stubRun'] = {
      startupMs,
      runMs: result.elapsedMs,
      events: result.events.length,
      eventKinds: [...kinds],
      timeline: timeline(result.events),
      changes,
      spendLogRows: logs.length,
      keyInfo: { spend: info.spend, maxBudget: info.maxBudget, metadata: info.metadata },
      listeningSockets: sockets,
      idle,
      afterRun: busy,
      serverInfo,
    };
  }, 300_000);

  it('FR-35: the config loop limit stops a looping agent (platform check and OpenHands check)', async () => {
    // 1. Platform check only: OpenHands' detector off, the poller interrupts after the config limit.
    const own = await newRun('poc-stub', settings.defaultRunBudgetUsd, false).start();
    await own.startTask('[poc:loop] Keep listing files.');
    const ownResult = await own.waitForEnd(120_000, 250);
    expect(ownResult.loopDetected).toBe(true);
    expect(ownResult.status).toBe('paused');
    expect(toRunStatus(ownResult.status, { stopReason: 'loop' })).toBe('stopped_stalled');
    const ownCalls = ownResult.events.filter((e) => e.kind === 'ActionEvent').length;
    expect(ownCalls).toBeGreaterThan(settings.identicalToolCallsMax);

    // 2. OpenHands' built-in detector on: it ends the conversation as `stuck` by itself.
    const builtIn = await newRun('poc-stub', settings.defaultRunBudgetUsd, true).start();
    await builtIn.startTask('[poc:loop] Keep listing files.');
    const builtInResult = await builtIn.waitForEnd(120_000, 250);
    const builtInCalls = builtInResult.events.filter((e) => e.kind === 'ActionEvent').length;
    expect(['stuck', 'paused']).toContain(builtInResult.status);
    report['loopRun'] = {
      limitFromConfig: settings.identicalToolCallsMax,
      platformCheck: {
        status: ownResult.status,
        identicalCallsSeen: ownCalls,
        elapsedMs: ownResult.elapsedMs,
      },
      openHandsCheck: {
        status: builtInResult.status,
        identicalCallsSeen: builtInCalls,
        platformInterruptedFirst: builtInResult.loopDetected,
        runStatus: toRunStatus(builtInResult.status, {
          stopReason: builtInResult.loopDetected ? 'loop' : undefined,
        }),
      },
    };
  }, 300_000);

  it('FR-34: interrupt is instant; kill switch removes the sandbox and revokes the key', async () => {
    const run = await newRun('poc-stub', settings.defaultRunBudgetUsd).start();
    await run.startTask('[poc:slow] Create the PoC file slowly.');
    await sleep(3_000);
    const t0 = Date.now();
    await run.client.interrupt(run.conversationId);
    const afterInterrupt = await run.client.getConversation(run.conversationId);
    const interruptMs = Date.now() - t0;
    expect(afterInterrupt.executionStatus).toBe('paused');

    const killMs = await run.kill();
    expect(await containerExists(run.sandboxName)).toBe(false);
    const call = await fetch(`${litellmUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${run.virtualKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'poc-stub', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(call.status).toBeGreaterThanOrEqual(400);
    expect(killMs).toBeLessThan(5 * 60_000);
    report['killRun'] = { interruptMs, killMs, revokedKeyHttpStatus: call.status };
  }, 300_000);

  it('FR-51: the virtual key budget blocks requests once spent', async () => {
    const key = await admin.createRunKey({
      labels: { ...runs[0]!.labels, run_id: 'budget-probe' },
      models: ['poc-stub'],
      maxBudgetUsd: 0.002,
      durationMinutes: 5,
    });
    const statuses: number[] = [];
    const errors: string[] = [];
    try {
      for (let i = 0; i < 4; i += 1) {
        const response = await fetch(`${litellmUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'poc-stub', messages: [{ role: 'user', content: 'hi' }] }),
        });
        statuses.push(response.status);
        const text = await response.text();
        if (!response.ok) errors.push(text.slice(0, 200));
      }
    } finally {
      await admin.deleteKey(key);
    }
    report['budgetProbe'] = { statuses, errors };
    // LiteLLM updates spend asynchronously, so the exact call that is blocked varies (ADR-M10).
    expect(statuses[0]).toBe(200);
    expect(statuses.at(-1)).toBe(429);
  }, 60_000);

  it('real Claude run through LiteLLM (capped at USD 1.00)', async (context) => {
    if (!realKeyConfigured) {
      // Deferred in C01 (no company key yet); a condition for C05 (QUESTIONS.md #15, ADR-M10 §3).
      report['realRun'] = 'deferred: POC_ANTHROPIC_API_KEY not set';
      context.skip();
    }
    const budget = realRunBudgetUsd(settings);
    const run = await newRun('poc-claude', budget).start();
    await run.startTask(
      'Create a file named hello.txt in the working directory that contains the single line ' +
        '"hello from OpenHands". Do not change any other file. Then finish.',
    );
    const result = await run.waitForEnd(settings.maxDurationMinutes * 60_000);
    const changes = await run.client.gitChanges(WORKING_DIR);
    const logs = await waitForSpendLogs(admin, run.virtualKey, 1);
    const info = await admin.keyInfo(run.virtualKey);
    report['realRun'] = {
      model: 'anthropic/claude-haiku-4-5-20251001',
      budgetUsd: budget,
      status: result.status,
      runMs: result.elapsedMs,
      events: result.events.length,
      changes,
      modelCalls: logs.length,
      spendUsd: info.spend,
    };
    expect(result.status).toBe('finished');
    expect(changes).toContainEqual({ path: 'hello.txt', status: 'ADDED' });
    expect(info.spend).toBeLessThanOrEqual(budget);
  }, 900_000);
});
