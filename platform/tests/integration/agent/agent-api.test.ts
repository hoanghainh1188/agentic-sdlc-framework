// D-08 E07 AC4, QUESTIONS #81: the real API-model run before the trial M-E. The runner drives the
// OpenHands Agent Server in a node24 sandbox; the agent calls a REAL API model,
// `claude-haiku-4-5-20251001` (ADR-M10 §3), through the development stack's own LiteLLM (Compose
// profile `models`), which renders its configuration from OpenBao with the provider key stored by
// the owner (runbook T11 §5d). The Cost Controller issues the run's virtual key (seven labels, a
// cap of at most USD 1.00); after the run the spend is synced into `cost_records`.
//
// DEVELOPER MACHINES ONLY, never in CI: `pnpm test:agent-api`, run by the owner in a terminal (not
// through a chat tool), on a machine where the dev stack runs with `pnpm compose:models`
// (GETTING-STARTED Step 13). No key is read from the environment or a file: the test reads the
// LiteLLM master key once from the configuration the sidecar rendered into LiteLLM's tmpfs
// (`readRenderedMasterKey`, ./litellm-master-key.ts: in memory as `Redacted`, the configuration
// never logged or kept, errors with fixed texts only; unit test agent/litellm-master-key.test.ts).
// The provider key never leaves LiteLLM.
//
// Settings: SDLC_AGENT_API_LITELLM_URL (default http://127.0.0.1:4000), SDLC_AGENT_API_LITELLM_CONTAINER
// (default: the running Compose service `litellm`), SDLC_SANDBOX_IMAGE (skips the node24 build),
// SDLC_AGENT_API_REPORT (a file that receives the numbers as JSON: time, calls, tokens, cost).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { OpenHandsAdapter } from '@sdlc/adapter-agent-openhands';
import { LiteLLMGateway } from '@sdlc/adapter-model-litellm';
import { COST_LABEL_NAMES } from '@sdlc/contracts';
import { Redacted } from '@sdlc/secrets';
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
import { docker, dockerSocket, quietly } from '../runner/live-helpers';
import { buildSandboxImage } from '../sandbox-image/helpers';
import { changesStep, startAgentRun } from './helpers';
import { readRenderedMasterKey } from './litellm-master-key';

const enabled = process.env.SDLC_AGENT_API_TEST === '1' && !!process.env.SDLC_TEST_DATABASE_URL;
/** The gateway name of the Anthropic entry in config.ctmpl (QUESTIONS #93: it carries the version). */
const MODEL = 'claude-haiku-4-5-20251001';
const BUDGET_CAP_USD = 1;
const RUN_TIMEOUT_MS = 30 * 60_000;
const LITELLM_URL = process.env.SDLC_AGENT_API_LITELLM_URL ?? 'http://127.0.0.1:4000';
const suffix = crypto.randomBytes(4).toString('hex');
const registryName = `sdlc-e07a-registry-${suffix}`;

/** The running LiteLLM container of the dev stack (Compose service `litellm`). */
function litellmContainer(): string {
  const named = process.env.SDLC_AGENT_API_LITELLM_CONTAINER;
  if (named) return named;
  const found = docker(
    'ps',
    '--filter',
    'label=com.docker.compose.service=litellm',
    '--filter',
    'status=running',
    '--format',
    '{{.Names}}',
  )
    .split('\n')
    .filter((n) => n !== '');
  if (found.length !== 1) {
    throw new Error(
      'start the dev stack with `pnpm compose:models` (one running LiteLLM), or set ' +
        'SDLC_AGENT_API_LITELLM_CONTAINER',
    );
  }
  return found[0]!;
}

describe.skipIf(!enabled)(`E07 AC4: a real run with the API model ${MODEL} (QUESTIONS #81)`, () => {
  let t: TestDatabase;
  let image: string;
  let client: DockerClient;
  let controller: CostController;
  let gateway: LiteLLMGateway;
  let container = '';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-e07-api-'));

  beforeAll(async () => {
    container = litellmContainer();
    gateway = new LiteLLMGateway({
      baseUrl: LITELLM_URL,
      masterKey: readRenderedMasterKey(container),
      timeoutMs: 60_000,
    });
    // The API model is served only when its provider key is in OpenBao (T11 §5d).
    expect(
      await gateway.listModels(),
      `${MODEL} is not served: store the key (T11 §5d)`,
    ).toContainEqual({ model: MODEL, providerType: 'api' });
    t = await createTestDatabase();
    image = process.env.SDLC_SANDBOX_IMAGE || (await buildSandboxImage(registryName));
    client = new DockerClient({ socketPath: dockerSocket(), timeoutMs: 120_000 });
    controller = new CostController({ gateway, db: t.app });
  }, 1_800_000);

  afterAll(async () => {
    quietly('rm', '-f', '-v', registryName);
    fs.rmSync(tmp, { recursive: true, force: true });
    await t?.drop();
  }, 120_000);

  it(
    'the agent writes hello.txt with the API model and finishes; labelled spend within the cap',
    { timeout: RUN_TIMEOUT_MS + 10 * 60_000 },
    async () => {
      let keyId = '';
      let virtualKey: Redacted | undefined;
      let cap = '';
      const run = await startAgentRun({
        t,
        client,
        image,
        tmp,
        suffix,
        slug: `e07-api-${suffix}`,
        litellmContainer: container,
        model: MODEL,
        planSummary: 'Create the file hello.txt in the repository root, as the specification says.',
        specText:
          '# T01 Hello file\n\n## Acceptance criteria\n\n- AC1: the file `hello.txt` exists in the repository root.\n- AC2: its content is exactly one line: `Hello from the platform.`\n',
        agentsMd:
          '# Agent instructions\n\n- Keep changes small. Do not install dependencies for this task.\n',
        caps: { maxIterations: 30, maxDurationMin: 20 },
        afterClaim: async (scope, envelope) => {
          // The cap: min(budget.default_run_usd, the contract's max_budget_usd 1.00).
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

        // End of run: revoke the key, then sync until the calls are in cost_records (C12).
        const from = new Date(started - 60_000);
        await controller.endRun({ keyId, syncFrom: from });
        let records = await run.scope.costRecords.listForRun(runId);
        for (let i = 0; i < 30 && records.length === 0; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          await controller.syncSpend({ from, to: new Date(Date.now() + 60_000) });
          records = await run.scope.costRecords.listForRun(runId);
        }
        // LiteLLM's own spend log of the run: every call carries the seven labels and a cost.
        const logged = (
          await gateway.listSpend({ from, to: new Date(Date.now() + 60_000) })
        ).records.filter((r) => r.labels.run_id === runId);

        const sum = (field: 'input_tokens' | 'output_tokens' | 'cached_input_tokens') =>
          records.reduce((s, r) => s + Number(r[field]), 0);
        const cost = records.reduce((s, r) => s + Number(r.cost_usd), 0);
        const report = {
          model: MODEL,
          outcome: result.outcome,
          status: result.status,
          seconds,
          iterations: result.outputs?.iterations,
          model_calls: records.length,
          spend_log_rows: logged.length,
          tokens_in: sum('input_tokens'),
          tokens_out: sum('output_tokens'),
          tokens_cached_in: sum('cached_input_tokens'),
          cost_usd: cost.toFixed(6),
          cap_usd: cap,
          changed_files: result.outputs?.changedFiles,
        };
        process.stderr.write(`E07 API RUN ${JSON.stringify(report)}\n`);
        if (process.env.SDLC_AGENT_API_REPORT) {
          fs.writeFileSync(process.env.SDLC_AGENT_API_REPORT, JSON.stringify(report, null, 2));
        }

        // Pass criteria (ADR-M10 §3, D-02 §10 item 6).
        expect(result).toMatchObject({ outcome: 'finished', status: 'succeeded' });
        expect(result.outputs?.changedFiles).toContainEqual({ path: 'hello.txt', status: 'added' });
        expect(Number(cap)).toBeLessThanOrEqual(BUDGET_CAP_USD);
        expect(cost).toBeGreaterThan(0);
        expect(cost).toBeLessThanOrEqual(Number(cap));
        expect(logged.length).toBeGreaterThan(0);
        expect(records).toHaveLength(logged.length);
        for (const r of logged) {
          for (const name of COST_LABEL_NAMES) expect(r.labels[name], name).toBeTruthy();
          expect(r.labels).toMatchObject({ run_id: runId, gate: 'G4', agent: 'coder-openhands' });
          expect(Number(r.costUsd)).toBeGreaterThan(0);
          expect(r.model).toBe(MODEL);
        }
        for (const r of records) {
          expect(r).toMatchObject({ run_id: runId, model: MODEL, provider_type: 'api' });
        }
        // The key is revoked: LiteLLM refuses it now.
        const after = await fetch(`${LITELLM_URL}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${virtualKey!.reveal()}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] }),
        });
        expect(after.status).toBe(401);
      } finally {
        await teardownSandbox(client, runId).catch(() => undefined);
        quietly('rm', '-f', run.relay);
      }
    },
  );
});
