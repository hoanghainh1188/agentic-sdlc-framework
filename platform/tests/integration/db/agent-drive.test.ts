// D-08 C05 on PostgreSQL: the runner drives the agent of a provisioned run (ADR-M29) with a fake
// agent adapter and stub Docker. Covers:
// - AC1/AC2: the agent starts with the contract, the model and the task (plan + spec, AGENTS.md);
// - AC3: iteration cap (the agent stops itself) and time cap (interrupt, then kill) end the run
//   with the right status and `stop_reason`;
// - AC4: changed files, last commit and log collected; `iterations` stored (`head_sha` in the
//   event `agent_finished` only: C08 records the pushed head);
// - QUESTIONS #80: the runner commits what the agent left, with the agent author;
// - failures before the start (LiteLLM not on the egress list, no spec) and a run killed meanwhile;
// - `Runner.runAgent` removes the sandbox and leaves the run network afterwards.
// - C07 (ADR-M34 §2.2, §2.6): every run that goes to G5 has its changes checked by the runner, or
//   it fails (`agent_changes_unavailable`); the spend of the run's key is watched: one warning, a
//   stop at the stop share (`stopped_budget`, `max_budget`), and an agent error is checked once
//   more after a bounded wait, because LiteLLM records spend late.
// - C11 PR 2 (FR-35, ADR-M42 §2.7): loop detection: more identical tool calls in a row than the
//   contract's threshold (`loop_detected`) or no new agent event for the configured window
//   (`no_progress`) → `stopped_stalled`; the budget wins over the loop in the same poll; a kill
//   still wins.
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
  type RunKeySpendReader,
  type SpendInfo,
  type StartAgentRun,
} from '@sdlc/contracts';
import { loadProjectConfig } from '@sdlc/config';
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
import { seedAgent } from '../agent-seed.js';
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

/** A status as tests write it; loop detection counts default to "progress on every poll". */
type FakeStatus = Pick<AgentRunStatus, 'state' | 'iterations'> & Partial<AgentRunStatus>;

/** Fills in the loop detection counts (C11 PR 2): the log grows on every poll, no repeats. */
function withProgress(status: FakeStatus, poll: number): AgentRunStatus {
  return { events: poll, identicalCalls: 0, ...status };
}

/** A scripted agent. `states` are returned by `getStatus` in order; the last one repeats. */
class FakeAgent implements AgentAdapter {
  started: StartAgentRun | undefined;
  stopped = 0;
  commits = 0;
  states: FakeStatus[] = [{ state: 'finished', iterations: 3 }];
  afterStop: FakeStatus | undefined = { state: 'stopped', iterations: 4 };
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
    this.#polls += 1;
    if (this.stopped > 0 && this.afterStop) {
      return Promise.resolve(withProgress(this.afterStop, this.#polls));
    }
    const status = this.states[Math.min(this.#polls - 1, this.states.length - 1)]!;
    return Promise.resolve(withProgress(status, this.#polls));
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
    changed = [];
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
    const agent = await seedAgent(scope, personA, { tools: ['file_editor', 'terminal'] });
    const input: IssueRunContract = {
      intentId: intent.id,
      planId: plan.id,
      baseSha: BASE,
      agent: {
        id: agent.id,
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

  /** Runs whose changes step was called (C07). */
  let changed: string[] = [];

  function deps(
    agent: FakeAgent,
    clock?: () => number,
    proposal?: AgentDriveDeps['proposal'],
  ): AgentDriveDeps {
    return {
      db: t.app as unknown as AgentDriveDeps['db'],
      docker,
      settings,
      adapter: agent,
      ...(clock ? { clock, sleep: () => Promise.resolve() } : {}),
      ...(proposal ? { proposal } : {}),
      changes: (contract) => {
        changed.push(contract.run_id);
        return Promise.resolve({ changedFiles: 2 });
      },
    };
  }

  /** A run key's spend as LiteLLM reports it: one answer per read, the last one repeats. */
  class FakeSpend implements RunKeySpendReader {
    reads = 0;
    keys: string[] = [];
    constructor(private readonly answers: (SpendInfo | Error)[]) {}
    readOwnSpend(key: RedactedSecret): Promise<SpendInfo> {
      this.keys.push(key.reveal());
      const answer = this.answers[Math.min(this.reads, this.answers.length - 1)]!;
      this.reads += 1;
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    }
  }
  const spent = (spendUsd: string): SpendInfo => ({ spendUsd, maxBudgetUsd: '0.5' });

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
    // C08 (ADR-M38 §2.2): the sandbox's HEAD goes to the event only; the push sets head_sha.
    expect(run).toMatchObject({
      status: 'succeeded',
      head_sha: null,
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

  it('C06 2b, L1: the runner stores a proposal; succeeded_proposal_only, no commit, no head_sha', async () => {
    const s = await seed({ extra: { autonomyLevel: 'L1' } });
    const agent = new FakeAgent();
    const seen: string[] = [];
    const result = await driveAgent(
      deps(agent, undefined, (contract, sandbox) => {
        seen.push(contract.run_id, sandbox.names.container);
        return Promise.resolve({ changedFiles: 5 });
      }),
      request(s),
    );
    expect(result).toMatchObject({ outcome: 'finished', status: 'succeeded_proposal_only' });
    // What the sandbox reports is never the result of an L1 run.
    expect(result.outputs).toBeUndefined();
    expect(seen).toEqual([s.envelope.contract.run_id, s.sandbox.names.container]);
    expect(agent.commits).toBe(0);
    expect(await s.scope.runs.getById(s.envelope.contract.run_id)).toMatchObject({
      status: 'succeeded_proposal_only',
      head_sha: null,
      stop_reason: null,
    });
    expect((await events(s)).at(-1)).toEqual([
      'agent_finished',
      { outcome: 'finished', iterations: 3, changed_files: 5 },
    ]);
    await noClientData(s);
  });

  it('C06 2b, L1: without a proposal store the run fails (agent_proposal_unavailable)', async () => {
    const s = await seed({ extra: { autonomyLevel: 'L1' } });
    const agent = new FakeAgent();
    const result = await driveAgent(deps(agent), request(s));
    expect(result.status).toBe('failed');
    expect(agent.commits).toBe(0);
    expect(await s.scope.runs.getById(s.envelope.contract.run_id)).toMatchObject({
      status: 'failed',
      stop_reason: 'agent_proposal_unavailable',
    });
  });

  it('C06 2b, L1: a proposal that cannot be computed or stored fails the run (agent_proposal_failed)', async () => {
    const s = await seed({ extra: { autonomyLevel: 'L1' } });
    const agent = new FakeAgent();
    const result = await driveAgent(
      deps(agent, undefined, () => Promise.reject(new Error(SECRET_PATH))),
      request(s),
    );
    expect(result.status).toBe('failed');
    expect(await s.scope.runs.getById(s.envelope.contract.run_id)).toMatchObject({
      status: 'failed',
      stop_reason: 'agent_proposal_failed',
    });
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
      head_sha: null,
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

  it('C06: a cancel stops the agent (interrupt) before anything is removed; failed, agent_cancelled', async () => {
    const s = await seed();
    const agent = new FakeAgent();
    agent.states = [{ state: 'running', iterations: 1 }];
    const abort = new AbortController();
    let polls = 0;
    const result = await driveAgent(
      {
        ...deps(agent),
        sleep: () => {
          polls += 1;
          if (polls === 2) abort.abort();
          return Promise.resolve();
        },
      },
      { ...request(s), signal: abort.signal },
    );
    expect(agent.stopped).toBe(1);
    expect(result).toMatchObject({
      outcome: 'failed',
      status: 'failed',
      stopReason: 'agent_cancelled',
    });
    expect(await events(s)).toContainEqual([
      'agent_stopped',
      { reason: 'cancelled', method: 'interrupt' },
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

  it('C11: a run killed before the agent starts ends stopped_killed, the agent never starts', async () => {
    const s = await seed();
    const agent = new FakeAgent();
    const runId = s.envelope.contract.run_id;
    await s.scope.runs.transition(runId, { from: ['running'], to: 'stopping', now: new Date() });
    const result = await driveAgent(deps(agent), request(s));
    expect(result).toMatchObject({
      outcome: 'killed',
      status: 'stopped_killed',
      stopReason: 'killed',
    });
    expect(agent.started).toBeUndefined();
    expect(await s.scope.runs.getById(runId)).toMatchObject({
      status: 'stopped_killed',
      stop_reason: 'killed',
    });
  });

  it('a run that left running otherwise is refused before the agent starts', async () => {
    const s = await seed();
    const agent = new FakeAgent();
    await s.scope.runs.transition(s.envelope.contract.run_id, {
      from: ['running'],
      to: 'failed',
      now: new Date(),
      stopReason: 'sandbox_lost',
    });
    await expect(driveAgent(deps(agent), request(s))).rejects.toMatchObject({
      reason: 'run_not_running',
    });
    expect(agent.started).toBeUndefined();
  });

  /** Moves the run to `stopping` on the `at`-th status poll, as `requestRunKill` does. */
  function killOnPoll(agent: FakeAgent, s: Seeded, at: number): void {
    const runId = s.envelope.contract.run_id;
    let polls = 0;
    const original = agent.getStatus.bind(agent);
    agent.getStatus = async () => {
      polls += 1;
      if (polls === at) {
        await s.scope.runs.transition(runId, {
          from: ['running'],
          to: 'stopping',
          now: new Date(),
        });
      }
      return polls < at + 5
        ? withProgress({ state: 'running', iterations: polls }, polls)
        : original();
    };
  }

  it('C11 AC2: a kill while the agent works stops it (interrupt), ends the run stopped_killed and stores its diff once the key is refused', async () => {
    const s = await seed();
    const agent = new FakeAgent();
    killOnPoll(agent, s, 2);
    const runId = s.envelope.contract.run_id;
    let checks = 0;
    const result = await driveAgent(
      {
        ...deps(agent),
        // The worker revokes the key: refused from the third check on.
        keyRevoked: (key) => {
          expect(key.reveal()).toBe(VIRTUAL_KEY);
          checks += 1;
          return Promise.resolve(checks >= 3);
        },
      },
      request(s),
    );
    expect(result).toMatchObject({
      outcome: 'killed',
      status: 'stopped_killed',
      stopReason: 'killed',
    });
    expect(agent.stopped).toBe(1);
    expect(agent.commits).toBe(0);
    expect(checks).toBe(3);
    expect(changed).toEqual([runId]);
    // Every process of the sandbox was killed before the workspace was read (security review).
    expect(stub.calls.map((c) => `${c.method} ${c.path}`)).toContain(
      `POST /containers/${s.sandbox.names.container}/kill`,
    );
    expect(await s.scope.runs.getById(runId)).toMatchObject({
      status: 'stopped_killed',
      stop_reason: 'killed',
      iterations: 4,
    });
    const events = (await s.scope.runEvents.list(runId)).map((e) => [e.event_type, e.payload]);
    expect(events).toContainEqual(['agent_stopped', { reason: 'killed', method: 'interrupt' }]);
    expect(events).toContainEqual(['agent_finished', { outcome: 'killed', iterations: 4 }]);
    expect(events.map(([type]) => type)).not.toContain('kill_evidence_failed');
    // Never the key or a path in the events.
    expect(JSON.stringify(events)).not.toContain(VIRTUAL_KEY);
    expect(JSON.stringify(events)).not.toContain(SECRET_PATH);
  });

  it('C11 (QUESTIONS #183): the diff waits for the key; never longer than killEvidenceMs, and the failure is only recorded', async () => {
    let now = 0;
    const clock = () => now;
    const bounded = { ...settings, agent: { ...settings.agent, killEvidenceMs: 1000 } };

    // The key is never refused: no diff, `key_not_revoked`.
    const s1 = await seed();
    const a1 = new FakeAgent();
    killOnPoll(a1, s1, 1);
    const r1 = await driveAgent(
      {
        ...deps(a1, clock),
        settings: bounded,
        sleep: (ms) => {
          now += ms;
          return Promise.resolve();
        },
        keyRevoked: () => Promise.resolve(false),
      },
      request(s1),
    );
    expect(r1).toMatchObject({ status: 'stopped_killed' });
    expect(changed).toEqual([]);
    const e1 = await s1.scope.runEvents.list(s1.envelope.contract.run_id);
    expect(e1.at(-1)).toMatchObject({
      event_type: 'kill_evidence_failed',
      payload: { reason: 'key_not_revoked' },
    });

    // No key check configured: no diff, `unavailable`. The diff step fails: `failed`.
    const s2 = await seed();
    const a2 = new FakeAgent();
    killOnPoll(a2, s2, 1);
    await driveAgent(deps(a2), request(s2));
    const e2 = await s2.scope.runEvents.list(s2.envelope.contract.run_id);
    expect(e2.at(-1)?.payload).toEqual({ reason: 'unavailable' });

    const s3 = await seed();
    const a3 = new FakeAgent();
    killOnPoll(a3, s3, 1);
    await driveAgent(
      {
        ...deps(a3),
        keyRevoked: () => Promise.resolve(true),
        changes: () => Promise.reject(new Error(`export failed ${SECRET_PATH}`)),
      },
      request(s3),
    );
    const e3 = await s3.scope.runEvents.list(s3.envelope.contract.run_id);
    expect(e3.at(-1)?.payload).toEqual({ reason: 'failed' });
    expect(await s3.scope.runs.getById(s3.envelope.contract.run_id)).toMatchObject({
      status: 'stopped_killed',
    });
  });

  it('C11 (code review): a kill after the last poll, while the runner commits, still ends the run stopped_killed', async () => {
    const s = await seed();
    const agent = new FakeAgent();
    const runId = s.envelope.contract.run_id;
    const commit = agent.commitWork.bind(agent);
    agent.commitWork = async (...args) => {
      await s.scope.runs.transition(runId, { from: ['running'], to: 'stopping', now: new Date() });
      return commit(...args);
    };
    const result = await driveAgent(deps(agent), request(s));
    expect(result).toMatchObject({
      outcome: 'killed',
      status: 'stopped_killed',
      stopReason: 'killed',
    });
    expect(await s.scope.runs.getById(runId)).toMatchObject({
      status: 'stopped_killed',
      stop_reason: 'killed',
    });
  });

  it("C11: the activity's cancel of a run being killed is the kill (stopped_killed, not failed)", async () => {
    const s = await seed();
    const agent = new FakeAgent();
    agent.states = [{ state: 'running', iterations: 1 }];
    const runId = s.envelope.contract.run_id;
    const abort = new AbortController();
    setTimeout(() => {
      void s.scope.runs
        .transition(runId, { from: ['running'], to: 'stopping', now: new Date() })
        .then(() => abort.abort());
    }, 50);
    // Without its database poll the driver would only see the cancel.
    const result = await driveAgent(deps(agent), { ...request(s), signal: abort.signal });
    expect(result).toMatchObject({ status: 'stopped_killed' });
    expect(agent.stopped).toBe(1);
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
        return withProgress({ state: 'running', iterations: 2 }, polls);
      }
      return withProgress(
        polls < 2 ? { state: 'running', iterations: 1 } : { state: 'finished', iterations: 3 },
        polls,
      );
    };
    const result = await driveAgent(deps(agent), request(s));
    expect(result).toMatchObject({ outcome: 'finished', status: undefined });
    expect(await s.scope.runs.getById(runId)).toMatchObject({
      status: 'stopped_killed',
      stop_reason: 'killed',
    });
  });

  it('Runner.runAgent removes the sandbox and leaves the run network afterwards (C07: no clone, no diff → failed)', async () => {
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
    // This runner did not provision the run, so it holds no clone: no run reaches G5 unchecked.
    expect(result).toMatchObject({ status: 'failed', stopReason: 'agent_changes_unavailable' });
    expect([stub.containers.size, stub.networks.size, stub.volumes.size]).toEqual([0, 0, 0]);
    const disconnected = stub.calls
      .filter((c) => c.path.endsWith('/disconnect'))
      .map((c) => (c.body as { Container: string }).Container);
    expect(disconnected).toContain(SELF);
    const last = (await s.scope.runEvents.list(s.envelope.contract.run_id)).at(-1);
    expect(last?.event_type).toBe('sandbox_removed');
    expect(last?.payload).toMatchObject({ reason: 'failed' });
  });

  it('C07: the changes step runs for every run that goes to G5, never for L1 proposals or failures', async () => {
    const finished = await seed();
    await driveAgent(deps(new FakeAgent()), request(finished));
    const capped = await seed();
    const agent = new FakeAgent();
    agent.states = [{ state: 'stopped', iterations: 30 }];
    await driveAgent(deps(agent), request(capped));
    const stuck = await seed();
    const stuckAgent = new FakeAgent();
    stuckAgent.states = [{ state: 'stuck', iterations: 8 }];
    await driveAgent(deps(stuckAgent), request(stuck));
    const l1 = await seed({ extra: { autonomyLevel: 'L1' } });
    await driveAgent(
      deps(new FakeAgent(), undefined, () => Promise.resolve({ changedFiles: 1 })),
      request(l1),
    );
    const broken = await seed();
    const errorAgent = new FakeAgent();
    errorAgent.states = [{ state: 'error', iterations: 1 }];
    await driveAgent(deps(errorAgent), request(broken));
    expect(changed).toEqual([
      finished.envelope.contract.run_id,
      capped.envelope.contract.run_id,
      stuck.envelope.contract.run_id,
    ]);
  });

  it('C07: without the changes step a finished run fails (agent_changes_unavailable)', async () => {
    const s = await seed();
    const result = await driveAgent({ ...deps(new FakeAgent()), changes: undefined }, request(s));
    expect(result).toMatchObject({ status: 'failed', stopReason: 'agent_changes_unavailable' });
    expect(await events(s)).toContainEqual(['agent_failed', { reason: 'changes_unavailable' }]);
  });

  it('C07: a changes step that fails fails the run, with nothing of the error stored', async () => {
    const s = await seed({ extra: { maxDurationMin: 1 } });
    const agent = new FakeAgent();
    agent.states = [{ state: 'running', iterations: 2 }];
    let now = 0;
    const result = await driveAgent(
      {
        ...deps(agent, () => (now += 20_000)),
        changes: () => Promise.reject(new Error(SECRET_PATH)),
      },
      request(s),
    );
    expect(result).toMatchObject({ status: 'failed', stopReason: 'agent_changes_unavailable' });
    expect(await s.scope.runs.getById(s.envelope.contract.run_id)).toMatchObject({
      status: 'failed',
      stop_reason: 'agent_changes_unavailable',
    });
    await noClientData(s);
  });

  const spendEvents = async (s: Seeded) =>
    (await s.scope.runEvents.list(s.envelope.contract.run_id))
      .map((e) => [e.event_type, e.payload] as const)
      .filter(([type]) => type === 'budget_warning' || type === 'agent_stopped');

  it('C07: one warning at 80 %, a stop at 100 % of the cap: stopped_budget, max_budget', async () => {
    const s = await seed();
    const agent = new FakeAgent();
    agent.states = [{ state: 'running', iterations: 2 }];
    const spend = new FakeSpend([spent('0.1'), spent('0.41'), spent('0.45'), spent('0.5')]);
    let now = 0;
    const result = await driveAgent(
      // Each poll moves the clock past the spend check interval (30 s).
      { ...deps(agent, () => (now += 31_000)), spendReader: spend },
      request(s),
    );
    expect(result).toMatchObject({
      outcome: 'max_budget',
      status: 'stopped_budget',
      stopReason: 'max_budget',
    });
    expect(agent.stopped).toBe(1);
    expect(spend.keys.every((k) => k === VIRTUAL_KEY)).toBe(true);
    expect(await spendEvents(s)).toEqual([
      ['budget_warning', { spend_usd: '0.41', max_budget_usd: '0.5', percent: 82 }],
      ['agent_stopped', { reason: 'max_budget', method: 'interrupt' }],
    ]);
    expect(await s.scope.runs.getById(s.envelope.contract.run_id)).toMatchObject({
      status: 'stopped_budget',
      stop_reason: 'max_budget',
    });
    // A budget stop goes to G5: its changes are checked.
    expect(changed).toEqual([s.envelope.contract.run_id]);
    await noClientData(s);
  });

  it('C07: an agent error with late spend is a budget stop after the bounded re-read, not failed', async () => {
    const s = await seed();
    const agent = new FakeAgent();
    agent.states = [{ state: 'error', iterations: 4 }];
    // LiteLLM has not recorded the last calls yet; after the wait it reports the full cap.
    const spend = new FakeSpend([spent('0.3'), spent('0.5')]);
    const waits: number[] = [];
    const result = await driveAgent(
      {
        ...deps(agent),
        spendReader: spend,
        sleep: (ms) => {
          waits.push(ms);
          return Promise.resolve();
        },
      },
      request(s),
    );
    expect(result).toMatchObject({ status: 'stopped_budget', stopReason: 'max_budget' });
    expect(spend.reads).toBe(2);
    expect(waits).toContain(settings.agent.spendRecheckMs);
    expect(await s.scope.runs.getById(s.envelope.contract.run_id)).toMatchObject({
      status: 'stopped_budget',
      stop_reason: 'max_budget',
    });
  });

  it('C07: an agent error below the cap after the re-read stays failed (agent_error)', async () => {
    const s = await seed();
    const agent = new FakeAgent();
    agent.states = [{ state: 'error', iterations: 4 }];
    const spend = new FakeSpend([spent('0.1'), spent('0.12')]);
    const result = await driveAgent(
      { ...deps(agent), spendReader: spend, sleep: () => Promise.resolve() },
      request(s),
    );
    expect(result).toMatchObject({ status: 'failed', stopReason: 'agent_error' });
    expect(spend.reads).toBe(2);
    expect(changed).toEqual([]);
  });

  it('C07: a spend read that fails is unknown: the run goes on and finishes', async () => {
    const s = await seed();
    const agent = new FakeAgent();
    agent.states = [
      { state: 'running', iterations: 1 },
      { state: 'running', iterations: 2 },
      { state: 'finished', iterations: 3 },
    ];
    const spend = new FakeSpend([new Error(VIRTUAL_KEY)]);
    let now = 0;
    const result = await driveAgent(
      { ...deps(agent, () => (now += 31_000)), spendReader: spend },
      request(s),
    );
    expect(result).toMatchObject({ status: 'succeeded' });
    expect(spend.reads).toBeGreaterThan(0);
    expect(await spendEvents(s)).toEqual([]);
    await noClientData(s);
  });

  const loopEvents = async (s: Seeded) =>
    (await s.scope.runEvents.list(s.envelope.contract.run_id))
      .map((e) => [e.event_type, e.payload] as const)
      .filter(([type]) => ['loop_detected', 'agent_stopped', 'agent_finished'].includes(type));

  const setWindow = async (s: Seeded, minutes: number) => {
    const yaml = `run:\n  loop_detection:\n    no_progress_window_minutes: ${String(minutes)}\n`;
    const loaded = loadProjectConfig(yaml);
    if (!loaded.ok) throw new Error('test configuration refused');
    await s.scope.projectConfigs.save(s.envelope.contract.project_id, {
      configYaml: yaml,
      configHash: loaded.configHash,
      updatedBy: null,
      expectedVersion: 0,
    });
  };

  it('C11 PR 2: more than loop_threshold identical tool calls → interrupt, stopped_stalled, loop_detected; counts only', async () => {
    const s = await seed();
    expect(s.envelope.contract.loop_threshold).toBe(3);
    const agent = new FakeAgent();
    agent.states = [1, 2, 3, 4].map((identicalCalls) => ({
      state: 'running' as const,
      iterations: identicalCalls,
      identicalCalls,
    }));
    const result = await driveAgent(
      deps(agent, () => 0),
      request(s),
    );
    expect(result).toMatchObject({
      outcome: 'loop_detected',
      status: 'stopped_stalled',
      stopReason: 'loop_detected',
    });
    expect(agent.stopped).toBe(1);
    expect(await s.scope.runs.getById(s.envelope.contract.run_id)).toMatchObject({
      status: 'stopped_stalled',
      stop_reason: 'loop_detected',
    });
    expect((await loopEvents(s)).slice(0, 2)).toEqual([
      ['loop_detected', { identical_calls: 4, threshold: 3, idle_minutes: 0 }],
      ['agent_stopped', { reason: 'loop_detected', method: 'interrupt' }],
    ]);
    // A stalled run goes to G5 (run_cap_reached): its changes are checked first.
    expect(changed).toEqual([s.envelope.contract.run_id]);
    await noClientData(s);
  });

  it('C11 PR 2: exactly loop_threshold identical calls never stop the run', async () => {
    const s = await seed();
    const agent = new FakeAgent();
    agent.states = [
      { state: 'running', iterations: 3, identicalCalls: 3 },
      { state: 'finished', iterations: 4, identicalCalls: 3 },
    ];
    expect(
      await driveAgent(
        deps(agent, () => 0),
        request(s),
      ),
    ).toMatchObject({
      outcome: 'finished',
      status: 'succeeded',
    });
  });

  it('C11 PR 2: no new agent event for the window read from the configuration → no_progress', async () => {
    const s = await seed();
    await setWindow(s, 5);
    const agent = new FakeAgent();
    agent.states = [{ state: 'running', iterations: 2, events: 9, identicalCalls: 1 }];
    let now = 0;
    // Every clock read moves 30 s: the log never grows.
    const result = await driveAgent(
      deps(agent, () => (now += 30_000)),
      request(s),
    );
    expect(result).toMatchObject({
      outcome: 'no_progress',
      status: 'stopped_stalled',
      stopReason: 'no_progress',
    });
    const [detected, stopped] = await loopEvents(s);
    expect(detected?.[0]).toBe('loop_detected');
    expect(detected?.[1]).toMatchObject({ identical_calls: 1, threshold: 3 });
    const idle = (detected?.[1] as { idle_minutes: number }).idle_minutes;
    // Read from the configuration (5), not the default (15).
    expect(idle).toBeGreaterThanOrEqual(5);
    expect(idle).toBeLessThan(15);
    expect(stopped).toEqual(['agent_stopped', { reason: 'no_progress', method: 'interrupt' }]);
    expect(await s.scope.runs.getById(s.envelope.contract.run_id)).toMatchObject({
      status: 'stopped_stalled',
      stop_reason: 'no_progress',
    });
    await noClientData(s);
  });

  it('C11 PR 2 (Harry): the budget and a loop due in the same poll → the budget wins (stopped_budget)', async () => {
    const s = await seed();
    const agent = new FakeAgent();
    agent.states = [{ state: 'running', iterations: 4, identicalCalls: 4 }];
    const spend = new FakeSpend([spent('0.5')]);
    let now = 0;
    const result = await driveAgent(
      // The first poll is past the spend check interval (30 s): both stops are due.
      { ...deps(agent, () => (now += 31_000)), spendReader: spend },
      request(s),
    );
    expect(result).toMatchObject({
      outcome: 'max_budget',
      status: 'stopped_budget',
      stopReason: 'max_budget',
    });
    expect(spend.reads).toBe(1);
    const recorded = await loopEvents(s);
    expect(recorded.map(([type]) => type)).not.toContain('loop_detected');
    expect(recorded[0]).toEqual(['agent_stopped', { reason: 'max_budget', method: 'interrupt' }]);
  });

  it('C11 PR 2: a kill that lands in the poll that finds a loop still ends the run stopped_killed', async () => {
    const s = await seed();
    const agent = new FakeAgent();
    const runId = s.envelope.contract.run_id;
    const original = agent.getStatus.bind(agent);
    let polls = 0;
    agent.getStatus = async () => {
      polls += 1;
      if (polls === 1) {
        // The kill lands after the driver's kill check, in the poll whose status shows the loop.
        await s.scope.runs.transition(runId, {
          from: ['running'],
          to: 'stopping',
          now: new Date(),
        });
        return { state: 'running', iterations: 4, events: 8, identicalCalls: 4 };
      }
      return original();
    };
    const result = await driveAgent(
      deps(agent, () => 0),
      request(s),
    );
    expect(result).toMatchObject({ outcome: 'killed', status: 'stopped_killed' });
    expect(await s.scope.runs.getById(s.envelope.contract.run_id)).toMatchObject({
      status: 'stopped_killed',
      stop_reason: 'killed',
    });
  });
});
