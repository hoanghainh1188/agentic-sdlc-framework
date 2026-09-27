// D-08 C05 AC1–AC4 live (ADR-M29): the runner drives the real OpenHands Agent Server 1.48.0 in a
// hardened sandbox from the node24 image, with a scripted stub model standing in for LiteLLM on
// the run's network (no provider, no real key). The real-model run is session 2 (QUESTIONS #78).
//
// `pnpm test:agent` (SDLC_AGENT_TEST=1, throw-away PostgreSQL from test-db.sh; CI job
// `sandbox-image`, which builds node24). `SDLC_SANDBOX_IMAGE` (name@sha256:…) skips the build.
//
// Test infrastructure through the docker CLI: the stub model, and a relay container that stands in
// for the runner's own container (the runner code attaches it to the run's network, and the test
// process on the host reaches the Agent Server through its port on 127.0.0.1). The sandboxes, the
// network attachment, the agent calls and the clean-up are the runner code under test.
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';
import { OpenHandsAdapter } from '@sdlc/adapter-agent-openhands';
import type { RedactedSecret, RunContractEnvelope } from '@sdlc/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createSandbox,
  DockerClient,
  driveAgent,
  packDirectory,
  Runner,
  runnerSettingsFromEnv,
  teardownSandbox,
  type AgentDriveDeps,
  type RunnerSettings,
  type Sandbox,
} from '../../../apps/runner/src/index.js';
import { parseTenantId } from '../../../packages/core/src/db/tenant-id.js';
import type { TenantScope } from '../../../packages/core/src/db/tenant-scope.js';
import { Registry } from '../../../packages/core/src/registry/registry.js';
import { issueRunContract } from '../../../packages/core/src/run-contract/index.js';
import { createTestDatabase, type TestDatabase } from '../db/helpers.js';
import { docker, dockerSocket, quietly } from '../runner/live-helpers';
import { buildSandboxImage } from '../sandbox-image/helpers';
import { repoRoot } from '../../workspace/helpers';

const enabled = process.env.SDLC_AGENT_TEST === '1' && !!process.env.SDLC_TEST_DATABASE_URL;
const NODE_IMAGE =
  'node:24.21.0-alpine3.23@sha256:9ec4a2e289874ed0d722e1772ec2de45d2801541db8612f3638b26f128c69ac2';
const SPEC_PATH = 'docs/specs/T01-labels.md';
const suffix = crypto.randomBytes(4).toString('hex');
const VIRTUAL_KEY = `sk-c05-live-${crypto.randomBytes(12).toString('hex')}`;
const CANARY = `agents-md-canary-${crypto.randomBytes(6).toString('hex')}`;
const names = {
  platformNet: `sdlc-c05-platform-${suffix}`,
  stub: `sdlc-c05-litellm-${suffix}`,
  registry: `sdlc-c05-registry-${suffix}`,
};
const here = path.join(repoRoot(), 'platform/tests/integration/agent');

const registry = new Registry({ policyFactory: (config) => createSimplePolicyEngine({ config }) });
const signer = {
  sign: () => Promise.resolve({ signature: 'vault:v1:c2lnbmF0dXJl', keyVersion: 1 }),
};
const secret = (value: string) =>
  ({ reveal: () => value, toString: () => '[redacted]' }) as RedactedSecret;

describe.skipIf(!enabled)('C05 live: the runner drives the OpenHands Agent Server', () => {
  let t: TestDatabase;
  let image: string;
  let client: DockerClient;
  let tenants = 0;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-c05-live-'));

  beforeAll(async () => {
    t = await createTestDatabase();
    image = process.env.SDLC_SANDBOX_IMAGE || (await buildSandboxImage(names.registry));
    client = new DockerClient({ socketPath: dockerSocket(), timeoutMs: 120_000 });
    docker('pull', '-q', NODE_IMAGE);
    docker('network', 'create', names.platformNet);
    docker(
      'run',
      '-d',
      '--name',
      names.stub,
      '--network',
      names.platformNet,
      '--read-only',
      '--cap-drop',
      'ALL',
      '--user',
      '1000:1000',
      '-e',
      `STUB_EXPECTED_KEY=${VIRTUAL_KEY}`,
      '-e',
      `STUB_AGENTS_CANARY=${CANARY}`,
      '-v',
      `${path.join(here, 'stub-model.mjs')}:/stub/stub-model.mjs:ro`,
      NODE_IMAGE,
      'node',
      '/stub/stub-model.mjs',
    );
  }, 1_200_000);

  afterAll(async () => {
    quietly('rm', '-f', names.stub, names.registry);
    quietly('network', 'rm', names.platformNet);
    fs.rmSync(tmp, { recursive: true, force: true });
    await t?.drop();
  });

  interface Run {
    readonly scope: TenantScope;
    readonly envelope: RunContractEnvelope;
    readonly sandbox: Sandbox;
    readonly settings: RunnerSettings;
    readonly relay: string;
    readonly relayUrl: string;
    readonly repoBase: string;
  }

  const git = (dir: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=f@f.invalid', ...args], {
      cwd: dir,
      encoding: 'utf8',
    }).trim();

  /** A fixture repository, a contract bound to it, and a running sandbox with the clone. */
  async function start(
    script: string,
    caps: { maxIterations: number; maxDurationMin: number },
  ): Promise<Run> {
    const repo = fs.mkdtempSync(path.join(tmp, 'repo-'));
    git(repo, 'init', '-q', '-b', 'main');
    fs.mkdirSync(path.join(repo, 'docs/specs'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'README.md'), '# Fixture\n');
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), `# Agent instructions\n\nMarker: ${CANARY}\n`);
    fs.writeFileSync(path.join(repo, SPEC_PATH), '# T01\n\nCreate hello.txt.\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'fixture');
    const baseSha = git(repo, 'rev-parse', 'HEAD');

    const slug = `c05-${String(++tenants)}`;
    const tenant = await t.app.system.createTenant({ slug, name: slug });
    const scope = t.app.forTenant(parseTenantId(tenant.id));
    const project = await scope.projects.create({
      slug: 'fixture',
      name: 'Fixture',
      git_provider: 'github',
      repo_full_name: 'org/fixture',
    });
    const person = (await scope.users.create({ display_name: 'a', email: 'a@example.com' })).id;
    const intent = await registry.createIntent(scope, {
      projectId: project.id,
      title: 'Hello',
      createdBy: person,
      riskTier: 'low',
      dataClass: 'internal',
    });
    const blob = fs.readFileSync(path.join(repo, SPEC_PATH));
    await registry.linkSpec(scope, intent.id, {
      path: SPEC_PATH,
      commitSha: baseSha,
      contentSha256: crypto.createHash('sha256').update(blob).digest('hex'),
      actorType: 'human',
      actorId: person,
    });
    const plan = await registry.submitPlan(scope, intent.id, {
      plannedFiles: ['hello.txt'],
      summary: `Create hello.txt. ${script}`,
      planSha256: 'b'.repeat(64),
      actorType: 'human',
      actorId: person,
    });
    const { envelope } = await issueRunContract(
      scope,
      {
        intentId: intent.id,
        planId: plan.id,
        baseSha,
        agent: {
          id: '66666666-6666-4666-8666-666666666666',
          version: '1.0.0',
          instructionsSha256: 'c'.repeat(64),
          tools: ['file_editor', 'terminal'],
        },
        planTools: ['file_editor', 'terminal'],
        autonomyLevel: 'L2',
        maxBudgetUsd: '1',
        ...caps,
        allowedModels: ['stub-model'],
        egressAllowlist: ['litellm:4000'],
        triggeredBy: null,
      },
      { signer },
    );
    const { contract } = envelope;
    git(repo, 'checkout', '-q', '-b', contract.branch);

    // The relay stands in for the runner's container (SDLC_RUNNER_SELF_CONTAINER).
    const relay = `sdlc-c05-relay-${contract.run_id.slice(0, 8)}`;
    docker(
      'run',
      '-d',
      '--name',
      relay,
      '-p',
      '127.0.0.1::8000',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--user',
      '1000:1000',
      '-e',
      `TARGET_HOST=sdlc-sandbox-${contract.run_id}`,
      '-v',
      `${path.join(here, 'relay.mjs')}:/relay/relay.mjs:ro`,
      NODE_IMAGE,
      'node',
      '/relay/relay.mjs',
    );
    const port = docker('port', relay, '8000/tcp').split('\n')[0]!.split(':').pop()!;

    const settings = runnerSettingsFromEnv({
      SDLC_RUNNER_DOCKER_SOCKET: dockerSocket(),
      SDLC_RUNNER_INSTANCE: `c05-${suffix}`,
      SDLC_RUNNER_EGRESS_SERVICES: `litellm=${names.stub}:4000`,
      SDLC_RUNNER_SELF_CONTAINER: relay,
      SDLC_RUNNER_AGENT_POLL_MS: '250',
      SDLC_RUNNER_AGENT_STOP_GRACE_SECONDS: '300',
    });
    await scope.runs.claimForProvisioning(contract.run_id, new Date());
    const sandbox = await createSandbox(client, settings, {
      runId: contract.run_id,
      tenantId: tenant.id,
      image,
      egressAllowlist: contract.egress_allowlist,
      workspaceTar: packDirectory(repo, 256 * 1024 * 1024),
    });
    for (let i = 0; ; i++) {
      const health = (await client.containerInspect(sandbox.containerId))?.State.Health?.Status;
      if (health === 'healthy') break;
      if (i > 240) throw new Error(`sandbox not healthy: ${String(health)}`);
      await new Promise((r) => setTimeout(r, 500));
    }
    await scope.runs.transition(contract.run_id, {
      from: ['provisioning'],
      to: 'running',
      now: new Date(),
    });
    return {
      scope,
      envelope,
      sandbox,
      settings,
      relay,
      relayUrl: `http://127.0.0.1:${port}`,
      repoBase: baseSha,
    };
  }

  const request = (r: Run) => ({
    contract: r.envelope.contract,
    sandbox: r.sandbox,
    model: 'stub-model',
    virtualKey: secret(VIRTUAL_KEY),
  });

  const agentEvents = async (r: Run) =>
    (await r.scope.runEvents.list(r.envelope.contract.run_id))
      .map((e) => [e.event_type, e.payload] as const)
      .filter(([type]) => type.startsWith('agent_'));

  const stubLogs = () => docker('logs', names.stub);

  it(
    'edit: the agent writes a file and finishes; the runner commits, collects, cleans up (AC1–AC4)',
    { timeout: 600_000 },
    async () => {
      const r = await start('[stub:edit]', { maxIterations: 30, maxDurationMin: 10 });
      const runId = r.envelope.contract.run_id;
      try {
        // The Agent Server API refuses callers without the session key: here LiteLLM's container,
        // which is on the run's network (Harry's condition, ADR-M29).
        const probe = (key: string) =>
          docker(
            'exec',
            names.stub,
            'node',
            '-e',
            `fetch('http://sdlc-sandbox-${runId}:8000/api/conversations/count',{headers:${JSON.stringify(
              key ? { 'X-Session-API-Key': key } : {},
            )}}).then(r=>console.log(r.status))`,
          );
        expect(probe('')).toBe('401');
        expect(probe('wrong-key-wrong-key-wrong-key-wrong-key')).toBe('401');

        const runner = new Runner(
          {
            db: t.app as unknown as AgentDriveDeps['db'],
            docker: client,
            settings: r.settings,
            verifier: {
              verify: () => Promise.resolve(false),
              publicKey: () => Promise.reject(new Error('unused')),
            },
            unwrapper: { unwrap: () => Promise.reject(new Error('unused')) },
          },
          {},
          { adapter: new OpenHandsAdapter(), agentUrl: () => r.relayUrl },
        );
        const result = await runner.runAgent(request(r));

        expect(result).toMatchObject({ outcome: 'finished', status: 'succeeded' });
        expect(result.outputs?.changedFiles).toEqual([{ path: 'hello.txt', status: 'added' }]);
        expect(result.outputs?.headSha).not.toBe(r.repoBase);
        expect(result.outputs?.events.length).toBeGreaterThan(2);
        const run = await r.scope.runs.getById(runId);
        expect(run).toMatchObject({ status: 'succeeded', head_sha: result.outputs?.headSha });
        expect(run?.iterations).toBeGreaterThanOrEqual(1);
        expect((await agentEvents(r)).map(([type]) => type)).toEqual([
          'agent_started',
          'agent_finished',
        ]);
        expect((await agentEvents(r))[1]?.[1]).toMatchObject({
          outcome: 'finished',
          commit: 'committed',
          changed_files: 1,
        });

        // AC2: the model saw the spec path, the planned file, the AGENTS.md rule, and the AGENTS.md
        // content (loaded by the agent from the workspace); only the granted tools.
        const logs = stubLogs();
        for (const check of ['spec_path', 'planned_file', 'agents_md_named', 'agents_md_loaded']) {
          expect(logs).toContain(`stub:check:${check}:yes`);
        }
        const tools = /stub:check:tools:(\S+)/.exec(logs)?.[1]?.split(',') ?? [];
        expect(tools).toEqual(expect.arrayContaining(['file_editor', 'terminal', 'finish']));
        expect(tools).not.toContain('browser');
        expect(logs).not.toContain('stub:refused:wrong_key');

        // Clean-up: sandbox, network and volume gone; the relay (runner) left the network.
        expect(docker('ps', '-a', '-q', '--filter', `name=sdlc-sandbox-${runId}`)).toBe('');
        expect(docker('network', 'ls', '-q', '--filter', `name=sdlc-run-${runId}`)).toBe('');
        expect(
          docker('inspect', '--format', '{{json .NetworkSettings.Networks}}', r.relay),
        ).not.toContain(`sdlc-run-${runId}`);
        const recorded = JSON.stringify(await r.scope.runEvents.list(runId));
        expect(recorded).not.toContain(VIRTUAL_KEY);
        expect(recorded).not.toContain('hello.txt');
      } finally {
        await teardownSandbox(client, runId).catch(() => undefined);
        quietly('rm', '-f', r.relay);
      }
    },
  );

  it(
    'iteration cap: the agent stops itself at max_iterations (AC3)',
    { timeout: 600_000 },
    async () => {
      const r = await start('[stub:loop]', { maxIterations: 3, maxDurationMin: 10 });
      const runId = r.envelope.contract.run_id;
      try {
        const result = await driveAgent(
          {
            db: t.app as unknown as AgentDriveDeps['db'],
            docker: client,
            settings: r.settings,
            adapter: new OpenHandsAdapter(),
            agentUrl: () => r.relayUrl,
          },
          request(r),
        );
        expect(result).toMatchObject({ outcome: 'max_iterations', status: 'stopped_budget' });
        expect(await r.scope.runs.getById(runId)).toMatchObject({ stop_reason: 'max_iterations' });
      } finally {
        await teardownSandbox(client, runId).catch(() => undefined);
        quietly('rm', '-f', r.relay);
      }
    },
  );

  it(
    'time cap: the runner interrupts the agent in a slow model call (AC3)',
    { timeout: 600_000 },
    async () => {
      const r = await start('[stub:slow]', { maxIterations: 30, maxDurationMin: 1 });
      const runId = r.envelope.contract.run_id;
      try {
        // One real second counts as one minute, so the one-minute cap ends after about a second
        // while the stub model holds its first reply for 120 s.
        const started = Date.now();
        const result = await driveAgent(
          {
            db: t.app as unknown as AgentDriveDeps['db'],
            docker: client,
            settings: r.settings,
            adapter: new OpenHandsAdapter(),
            agentUrl: () => r.relayUrl,
            clock: () => started + (Date.now() - started) * 60,
          },
          request(r),
        );
        expect(result).toMatchObject({ outcome: 'max_duration', status: 'stopped_timeout' });
        expect(await agentEvents(r)).toContainEqual([
          'agent_stopped',
          { reason: 'max_duration', method: 'interrupt' },
        ]);
        expect(Date.now() - started).toBeLessThan(60_000);
      } finally {
        await teardownSandbox(client, runId).catch(() => undefined);
        quietly('rm', '-f', r.relay);
      }
    },
  );
});
