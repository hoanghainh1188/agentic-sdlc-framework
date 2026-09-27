// D-08 C05 on PostgreSQL: the runner drives the agent of a provisioned run (ADR-M29) with a fake
// agent adapter and stub Docker. Covers:
// - AC1/AC2: the agent starts with the contract, the model and the task (plan + spec, AGENTS.md);
// - AC3: iteration cap (the agent stops itself) and time cap (interrupt, then kill) end the run
//   with the right status and `stop_reason`;
// - AC4: changed files, last commit and log collected; `head_sha` and `iterations` stored;
// - QUESTIONS #80: the runner commits what the agent left, with the agent author;
// - failures before the start (LiteLLM not on the egress list, no spec) and a run killed meanwhile;
// - `Runner.runAgent` removes the sandbox and leaves the run network afterwards.
// Run events hold codes and counts only: no path, no key, no text.
import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';
import {
  AgentError,
  type AgentAdapter,
  type AgentCommit,
  type AgentOutputs,
  type AgentRunHandle,
  type AgentRunStatus,
  type RedactedSecret,
  type RunContractEnvelope,
  type StartAgentRun,
} from '@sdlc/contracts';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import {
  createSandbox,
  DockerClient,
  driveAgent,
  Runner,
  runnerSettingsFromEnv,
  type AgentDriveDeps,
  type RunnerSettings,
  type Sandbox,
} from '../../../apps/runner/src/index.js';
import { parseTenantId } from '../../../packages/core/src/db/tenant-id.js';
import type { TenantScope } from '../../../packages/core/src/db/tenant-scope.js';
import { Registry } from '../../../packages/core/src/registry/registry.js';
import {
  issueRunContract,
  type IssueRunContract,
} from '../../../packages/core/src/run-contract/index.js';
import { StubDocker } from '../../runner/stub-docker.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

const REPO = 'org/pilot-order-inventory';
const SHA = (c: string) => c.repeat(64);
const BASE = 'a'.repeat(40);
const HEAD = 'f'.repeat(40);
const IMAGE =
  'ghcr.io/openhands/agent-server:1.48.0-python-slim@sha256:8fcfab2dedb4b41b6aef219b9fa9b1f2588033fad3d998ae6aa11fe8c4fcf8b7';
const SELF = 'sdlc-test-runner-1';
const VIRTUAL_KEY = 'sk-virtual-canary-0123456789abcdef';
const SECRET_PATH = 'apps/web/src/products/secret-client-file.vue';

const registry = new Registry({ policyFactory: (config) => createSimplePolicyEngine({ config }) });
const signer = {
  sign: () => Promise.resolve({ signature: 'vault:v1:c2lnbmF0dXJl', keyVersion: 1 }),
};

function secret(value: string): RedactedSecret {
  return { reveal: () => value, toString: () => '[redacted]' } as RedactedSecret;
}

/** A scripted agent. `states` are returned by `getStatus` in order; the last one repeats. */
class FakeAgent implements AgentAdapter {
  started: StartAgentRun | undefined;
  stopped = 0;
  commits = 0;
  states: AgentRunStatus[] = [{ state: 'finished', iterations: 3 }];
  afterStop: AgentRunStatus | undefined = { state: 'stopped', iterations: 4 };
  commitError: AgentError | undefined;
  #polls = 0;

  startRun(input: StartAgentRun): Promise<AgentRunHandle> {
    this.started = input;
    return Promise.resolve({
      runId: input.contract.run_id,
      conversationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      endpoint: input.endpoint,
      workingDir: input.workingDir,
    });
  }

  getStatus(): Promise<AgentRunStatus> {
    if (this.stopped > 0 && this.afterStop) return Promise.resolve(this.afterStop);
    const status = this.states[Math.min(this.#polls, this.states.length - 1)]!;
    this.#polls += 1;
    return Promise.resolve(status);
  }

  stop(): Promise<void> {
    this.stopped += 1;
    return Promise.resolve();
  }

  commitWork(): Promise<AgentCommit> {
    this.commits += 1;
    if (this.commitError) return Promise.reject(this.commitError);
    return Promise.resolve({ headSha: HEAD, committed: true });
  }

  collectOutputs(): Promise<AgentOutputs> {
    return Promise.resolve({
      changedFiles: [
        { path: SECRET_PATH, status: 'added' },
        { path: 'README.md', status: 'modified' },
      ],
      headSha: HEAD,
      iterations: 3,
      events: [{ kind: 'ActionEvent' }],
    });
  }
}

describeDb('C05: the runner drives the agent, on PostgreSQL', () => {
  let t: TestDatabase;
  let stub: StubDocker;
  let docker: DockerClient;
  let settings: RunnerSettings;
  let tenants = 0;

  beforeAll(async () => {
    t = await createTestDatabase();
    stub = await StubDocker.start();
    docker = new DockerClient({ socketPath: stub.socketPath, timeoutMs: 5000 });
    settings = runnerSettingsFromEnv({
      SDLC_RUNNER_DOCKER_SOCKET: stub.socketPath,
      SDLC_RUNNER_EGRESS_SERVICES: 'litellm=sdlc-litellm-1:4000,npm-proxy=sdlc-npm-proxy-1:4873',
      SDLC_RUNNER_SELF_CONTAINER: SELF,
      SDLC_RUNNER_AGENT_POLL_MS: '100',
      SDLC_RUNNER_AGENT_STOP_GRACE_SECONDS: '5',
    });
  }, 60_000);

  afterAll(async () => {
    await stub?.stop();
    await t?.drop();
  });

  beforeEach(() => {
    stub.calls.length = 0;
    stub.containers.clear();
    stub.networks.clear();
    stub.volumes.clear();
    stub.images.add(IMAGE);
  });

  interface Seeded {
    readonly scope: TenantScope;
    readonly envelope: RunContractEnvelope;
    readonly sandbox: Sandbox;
  }

  async function seed(
    options: { spec?: boolean; extra?: Partial<IssueRunContract> } = {},
  ): Promise<Seeded> {
    const slug = `agent-${String(++tenants)}`;
    const tenant = await t.app.system.createTenant({ slug, name: slug });
    const scope = t.app.forTenant(parseTenantId(tenant.id));
    const project = await scope.projects.create({
      slug: 'shop',
      name: 'Shop',
      git_provider: 'github',
      repo_full_name: REPO,
    });
    const personA = (await scope.users.create({ display_name: 'a', email: 'a@example.com' })).id;
    const intent = await registry.createIntent(scope, {
      projectId: project.id,
      title: 'Add Japanese labels',
      createdBy: personA,
      riskTier: 'low',
      dataClass: 'internal',
    });
    if (options.spec !== false) {
      await registry.linkSpec(scope, intent.id, {
        path: 'docs/specs/T01-japanese-labels.md',
        commitSha: BASE,
        contentSha256: SHA('d'),
        actorType: 'human',
        actorId: personA,
      });
    }
    const plan = await registry.submitPlan(scope, intent.id, {
      plannedFiles: ['apps/web/src/products/**'],
      summary: 'Add Japanese labels to the product list.',
      planSha256: SHA('b'),
      actorType: 'human',
      actorId: personA,
    });
    const input: IssueRunContract = {
      intentId: intent.id,
      planId: plan.id,
      baseSha: BASE,
      agent: {
        id: '66666666-6666-4666-8666-666666666666',
        version: '1.0.0',
        instructionsSha256: SHA('c'),
        tools: ['file_editor', 'terminal'],
      },
      planTools: ['file_editor', 'terminal'],
      autonomyLevel: 'L2',
      maxBudgetUsd: '1',
      maxIterations: 30,
      maxDurationMin: 60,
      allowedModels: ['stub-model'],
      egressAllowlist: ['litellm:4000'],
      triggeredBy: null,
      ...options.extra,
    };
    const { envelope } = await issueRunContract(scope, input, { signer });
    const runId = envelope.contract.run_id;
    // As `provisionRun` leaves it: claimed, sandbox created, `running`.
    await scope.runs.claimForProvisioning(runId, new Date());
    await scope.runs.transition(runId, { from: ['provisioning'], to: 'running', now: new Date() });
    const sandbox = await createSandbox(docker, settings, {
      runId,
      tenantId: tenant.id,
      image: IMAGE,
      egressAllowlist: envelope.contract.egress_allowlist,
    });
    return { scope, envelope, sandbox };
  }

  function deps(agent: FakeAgent, clock?: () => number): AgentDriveDeps {
    return {
      db: t.app as unknown as AgentDriveDeps['db'],
      docker,
      settings,
      adapter: agent,
      ...(clock ? { clock, sleep: () => Promise.resolve() } : {}),
    };
  }

  const request = (s: Seeded) => ({
    contract: s.envelope.contract,
    sandbox: s.sandbox,
    model: 'stub-model',
    virtualKey: secret(VIRTUAL_KEY),
  });

  const events = async (s: Seeded) =>
    (await s.scope.runEvents.list(s.envelope.contract.run_id))
      .map((e) => [e.event_type, e.payload] as const)
      .filter(([type]) => type.startsWith('agent_'));

  const noClientData = async (s: Seeded) => {
    const text = JSON.stringify(await s.scope.runEvents.list(s.envelope.contract.run_id));
    expect(text).not.toContain(SECRET_PATH);
    expect(text).not.toContain(VIRTUAL_KEY);
    expect(text).not.toContain(s.sandbox.sessionApiKey);
  };

  it('finished: commits what was left, collects outputs, succeeded (AC1, AC2, AC4, #80)', async () => {
    const s = await seed();
    const agent = new FakeAgent();
    const result = await driveAgent(deps(agent), request(s));

    expect(result).toMatchObject({ outcome: 'finished', status: 'succeeded' });
    expect(result.outputs?.changedFiles).toHaveLength(2);
    const started = agent.started!;
    expect(started.model).toMatchObject({ model: 'stub-model', baseUrl: 'http://litellm:4000' });
    expect(started.model.virtualKey.reveal()).toBe(VIRTUAL_KEY);
    expect(started.endpoint.baseUrl).toBe(`http://${s.sandbox.names.container}:8000`);
    expect(started.endpoint.sessionKey.reveal()).toBe(s.sandbox.sessionApiKey);
    expect(started.task).toEqual({
      spec: {
        path: 'docs/specs/T01-japanese-labels.md',
        commitSha: BASE,
        contentSha256: SHA('d'),
      },
      plan: {
        summary: 'Add Japanese labels to the product list.',
        plannedFiles: ['apps/web/src/products/**'],
      },
    });
    expect(started.workingDir).toBe('/workspace');
    expect(agent.commits).toBe(1);
    expect([...(stub.networks.get(s.sandbox.names.network)?.attached ?? [])]).toContain(SELF);

    const run = await s.scope.runs.getById(s.envelope.contract.run_id);
    expect(run).toMatchObject({
      status: 'succeeded',
      head_sha: HEAD,
      iterations: 3,
      stop_reason: null,
    });
    expect(run?.finished_at).toBeInstanceOf(Date);
    expect(await events(s)).toEqual([
      ['agent_started', { max_iterations: 30, max_duration_min: 60 }],
      [
        'agent_finished',
        {
          outcome: 'finished',
          iterations: 3,
          changed_files: 2,
          head_sha: HEAD,
          commit: 'committed',
        },
      ],
    ]);
    await noClientData(s);
  });

  it('iteration cap: the agent stops itself; stopped_budget, max_iterations, no commit (AC3)', async () => {
    const s = await seed();
    const agent = new FakeAgent();
    agent.states = [
      { state: 'running', iterations: 10 },
      { state: 'stopped', iterations: 30 },
    ];
    const result = await driveAgent(deps(agent), request(s));
    expect(result).toMatchObject({ outcome: 'max_iterations', status: 'stopped_budget' });
    expect(agent.commits).toBe(0);
    expect(await s.scope.runs.getById(s.envelope.contract.run_id)).toMatchObject({
      status: 'stopped_budget',
      stop_reason: 'max_iterations',
      head_sha: HEAD,
    });
  });

  it('time cap: interrupt, the agent stops in the grace period; stopped_timeout (AC3)', async () => {
    const s = await seed({ extra: { maxDurationMin: 1 } });
    const agent = new FakeAgent();
    agent.states = [{ state: 'running', iterations: 2 }];
    let now = 0;
    const clock = () => (now += 20_000);
    const result = await driveAgent(deps(agent, clock), request(s));
    expect(agent.stopped).toBe(1);
    expect(result).toMatchObject({ outcome: 'max_duration', status: 'stopped_timeout' });
    expect(result.outputs).toBeDefined();
    expect(await events(s)).toContainEqual([
      'agent_stopped',
      { reason: 'max_duration', method: 'interrupt' },
    ]);
    expect(await s.scope.runs.getById(s.envelope.contract.run_id)).toMatchObject({
      stop_reason: 'max_duration',
    });
  });

  it('time cap: the agent does not stop, so the runner kills it (no outputs) (AC3)', async () => {
    const s = await seed({ extra: { maxDurationMin: 1 } });
    const agent = new FakeAgent();
    agent.states = [{ state: 'running', iterations: 2 }];
    agent.afterStop = undefined;
    let now = 0;
    const result = await driveAgent(
      deps(agent, () => (now += 20_000)),
      request(s),
    );
    expect(result).toMatchObject({ outcome: 'max_duration', status: 'stopped_timeout' });
    expect(result.outputs).toBeUndefined();
    expect(await events(s)).toContainEqual([
      'agent_stopped',
      { reason: 'max_duration', method: 'kill' },
    ]);
    expect(await events(s)).toContainEqual([
      'agent_finished',
      { outcome: 'max_duration', iterations: 2 },
    ]);
  });

  it('stuck: stopped_stalled with agent_stuck', async () => {
    const s = await seed();
    const agent = new FakeAgent();
    agent.states = [{ state: 'stuck', iterations: 8 }];
    expect(await driveAgent(deps(agent), request(s))).toMatchObject({ status: 'stopped_stalled' });
    expect(await s.scope.runs.getById(s.envelope.contract.run_id)).toMatchObject({
      stop_reason: 'agent_stuck',
    });
  });

  it('refuses to start when LiteLLM is not on the egress list: agent_model_unreachable', async () => {
    const s = await seed({ extra: { egressAllowlist: ['npm-proxy:4873'] } });
    const agent = new FakeAgent();
    const result = await driveAgent(deps(agent), request(s));
    // The sandbox of this run has no LiteLLM either; the driver fails before any agent call.
    expect(result).toMatchObject({ outcome: 'failed', status: 'failed' });
    expect(agent.started).toBeUndefined();
    expect(await events(s)).toEqual([['agent_failed', { reason: 'model_unreachable' }]]);
    expect(await s.scope.runs.getById(s.envelope.contract.run_id)).toMatchObject({
      stop_reason: 'agent_model_unreachable',
    });
  });

  it('refuses to start without a spec: task_unavailable', async () => {
    const s = await seed({ spec: false });
    const agent = new FakeAgent();
    expect(await driveAgent(deps(agent), request(s))).toMatchObject({ status: 'failed' });
    expect(agent.started).toBeUndefined();
    expect(await events(s)).toEqual([['agent_failed', { reason: 'task_unavailable' }]]);
  });

  it('the agent left the branch: no commit, failed with agent_branch_changed', async () => {
    const s = await seed();
    const agent = new FakeAgent();
    agent.commitError = new AgentError('branch_changed');
    expect(await driveAgent(deps(agent), request(s))).toMatchObject({ status: 'failed' });
    expect(await s.scope.runs.getById(s.envelope.contract.run_id)).toMatchObject({
      stop_reason: 'agent_branch_changed',
    });
  });

  it('changes nothing when the run left running meanwhile (kill switch, C11)', async () => {
    const s = await seed();
    const agent = new FakeAgent();
    await s.scope.runs.transition(s.envelope.contract.run_id, {
      from: ['running'],
      to: 'stopping',
      now: new Date(),
    });
    await expect(driveAgent(deps(agent), request(s))).rejects.toMatchObject({
      reason: 'run_not_running',
    });
    expect(agent.started).toBeUndefined();
  });

  it('a kill during polling wins: the driver does not overwrite the stopped run (C11 race)', async () => {
    const s = await seed();
    const agent = new FakeAgent();
    const runId = s.envelope.contract.run_id;
    let polls = 0;
    agent.getStatus = async () => {
      polls += 1;
      if (polls === 2) {
        // The kill switch (C11) ends the run while the agent is working.
        await s.scope.runs.transition(runId, {
          from: ['running'],
          to: 'stopped_killed',
          now: new Date(),
          stopReason: 'killed',
        });
        return { state: 'running', iterations: 2 };
      }
      return polls < 2 ? { state: 'running', iterations: 1 } : { state: 'finished', iterations: 3 };
    };
    const result = await driveAgent(deps(agent), request(s));
    expect(result).toMatchObject({ outcome: 'finished', status: undefined });
    expect(await s.scope.runs.getById(runId)).toMatchObject({
      status: 'stopped_killed',
      stop_reason: 'killed',
    });
  });

  it('Runner.runAgent removes the sandbox and leaves the run network afterwards', async () => {
    const s = await seed();
    const agent = new FakeAgent();
    const runner = new Runner(
      {
        db: t.app as unknown as AgentDriveDeps['db'],
        docker,
        settings,
        verifier: {
          verify: () => Promise.resolve(true),
          publicKey: () => Promise.resolve(new Uint8Array()),
        },
        unwrapper: { unwrap: () => Promise.reject(new Error('unused')) },
      },
      {},
      { adapter: agent },
    );
    const result = await runner.runAgent(request(s));
    expect(result.status).toBe('succeeded');
    expect([stub.containers.size, stub.networks.size, stub.volumes.size]).toEqual([0, 0, 0]);
    const disconnected = stub.calls
      .filter((c) => c.path.endsWith('/disconnect'))
      .map((c) => (c.body as { Container: string }).Container);
    expect(disconnected).toContain(SELF);
    const last = (await s.scope.runEvents.list(s.envelope.contract.run_id)).at(-1);
    expect(last?.event_type).toBe('sandbox_removed');
    expect(last?.payload).toMatchObject({ reason: 'finished' });
  });
});
