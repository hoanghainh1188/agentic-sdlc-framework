// C05 (ADR-M29, ADR-M25 §5), Harry's conditions for the runner joining the run's network:
// - only the runner's own container (and the configured egress services) may join a run network;
// - the runner leaves the network at clean-up;
// - the runner listens on no port, so joining gives the sandbox nothing to reach;
// - the Agent Server needs the per-run session key, which only the runner holds (the adapter sends
//   it on every call: tests/agent/adapter.test.ts; refused without it: the live test).
// Also the agent settings and the driver's small pure rules.
import fs from 'node:fs';
import path from 'node:path';

import { AGENT_ERROR_CODES, AgentError } from '@sdlc/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  AGENT_ERROR_MESSAGES,
  agentErrorMessage,
  AgentRunError,
  agentUrl,
  assertSafeNetworkConnect,
  attachRunner,
  createSandbox,
  DockerClient,
  llmReachable,
  outcomeOf,
  RunnerError,
  teardownSandbox,
} from '../../apps/runner/src/index.js';
import { CONTRACT } from '../agent/helpers';
import { repoRoot } from '../workspace/helpers';
import { IMAGE, RUN_ID, settings, TENANT_ID } from './helpers';
import { StubDocker } from './stub-docker';

const SELF = 'sdlc-sdlc-runner-1';

describe('agent settings', () => {
  it('has defaults: port 8000, LiteLLM at litellm:4000, no runner container', () => {
    expect(settings().agent).toEqual({
      selfContainer: undefined,
      port: 8000,
      llmBaseUrl: 'http://litellm:4000',
      pollMs: 1000,
      stopGraceMs: 30_000,
      spendCheckMs: 30_000,
      spendRecheckMs: 25_000,
    });
  });

  it('C07: reads the spend check and the bounded re-read wait', () => {
    const agent = settings({
      SDLC_RUNNER_AGENT_SPEND_CHECK_SECONDS: '10',
      SDLC_RUNNER_AGENT_SPEND_RECHECK_SECONDS: '2',
    }).agent;
    expect(agent).toMatchObject({ spendCheckMs: 10_000, spendRecheckMs: 2000 });
    expect(() => settings({ SDLC_RUNNER_AGENT_SPEND_CHECK_SECONDS: '1' })).toThrow();
    expect(() => settings({ SDLC_RUNNER_AGENT_SPEND_RECHECK_SECONDS: '61' })).toThrow();
  });

  it('reads the runner container and the agent timings', () => {
    const agent = settings({
      SDLC_RUNNER_SELF_CONTAINER: SELF,
      SDLC_RUNNER_AGENT_POLL_MS: '250',
      SDLC_RUNNER_AGENT_STOP_GRACE_SECONDS: '5',
    }).agent;
    expect(agent).toMatchObject({ selfContainer: SELF, pollMs: 250, stopGraceMs: 5000 });
  });

  it.each([
    ['SDLC_RUNNER_SELF_CONTAINER', '../x'],
    ['SDLC_RUNNER_AGENT_LLM_URL', 'http://litellm'],
    ['SDLC_RUNNER_AGENT_LLM_URL', 'http://user:pw@litellm:4000'],
    ['SDLC_RUNNER_AGENT_LLM_URL', 'http://api.openai.com:443'],
    ['SDLC_RUNNER_AGENT_POLL_MS', '10'],
    ['SDLC_RUNNER_AGENT_STOP_GRACE_SECONDS', '0'],
  ])('refuses %s=%s', (name, value) => {
    expect(() => settings({ [name]: value })).toThrow(RunnerError);
  });
});

describe('assertSafeNetworkConnect', () => {
  it('lets only listed containers join a run network', () => {
    expect(() => assertSafeNetworkConnect(`sdlc-run-${RUN_ID}`, SELF, [SELF])).not.toThrow();
    expect(() => assertSafeNetworkConnect(`sdlc-run-${RUN_ID}`, 'sdlc-openbao-1', [SELF])).toThrow(
      /connect_container/,
    );
    expect(() => assertSafeNetworkConnect('sdlc_default', SELF, [SELF])).toThrow(/connect_network/);
  });
});

describe('the runner on the run network (stub Docker)', () => {
  let stub: StubDocker;
  let docker: DockerClient;
  const s = settings({ SDLC_RUNNER_SELF_CONTAINER: SELF });
  const input = {
    runId: RUN_ID,
    tenantId: TENANT_ID,
    image: IMAGE,
    egressAllowlist: ['litellm:4000'],
  };

  beforeAll(async () => {
    stub = await StubDocker.start();
    docker = new DockerClient({ socketPath: stub.socketPath, timeoutMs: 5000 });
  });
  afterAll(() => stub.stop());
  beforeEach(() => {
    stub.calls.length = 0;
    stub.containers.clear();
    stub.networks.clear();
    stub.volumes.clear();
    stub.images.add(IMAGE);
  });

  it('joins once with its own container, and returns the sandbox URL and session key', async () => {
    const sandbox = await createSandbox(docker, s, input);
    const endpoint = await attachRunner(docker, s, sandbox);
    await attachRunner(docker, s, sandbox);
    expect(endpoint.baseUrl).toBe(`http://sdlc-sandbox-${RUN_ID}:8000`);
    expect(agentUrl(RUN_ID, s)).toBe(endpoint.baseUrl);
    expect(endpoint.sessionKey.reveal()).toBe(sandbox.sessionApiKey);
    expect(JSON.stringify(endpoint)).not.toContain(sandbox.sessionApiKey);
    const net = stub.networks.get(`sdlc-run-${RUN_ID}`);
    expect([...(net?.attached ?? [])]).toContain(SELF);
    const connects = stub.calls.filter(
      (c) => c.path.endsWith('/connect') && (c.body as { Container: string }).Container === SELF,
    );
    expect(connects).toHaveLength(1);
    await teardownSandbox(docker, RUN_ID);
  });

  it('leaves the run network at clean-up (every container detached, network removed)', async () => {
    const sandbox = await createSandbox(docker, s, input);
    await attachRunner(docker, s, sandbox);
    await teardownSandbox(docker, RUN_ID);
    const disconnected = stub.calls
      .filter((c) => c.path.endsWith('/disconnect'))
      .map((c) => (c.body as { Container: string }).Container);
    expect(disconnected).toEqual(expect.arrayContaining([SELF, 'sdlc-litellm-1']));
    expect(stub.networks.size).toBe(0);
  });

  it('refuses to join without a configured runner container', async () => {
    const sandbox = await createSandbox(docker, settings(), input);
    await expect(attachRunner(docker, settings(), sandbox)).rejects.toMatchObject({
      reason: 'runner_not_attachable',
    });
    await teardownSandbox(docker, RUN_ID);
  });
});

describe('the runner listens on no port', () => {
  // Static check of the runner sources: no server, no listening socket. The live Compose test
  // checks the running container too (/proc/net/tcp has no LISTEN entry).
  const dir = path.join(repoRoot(), 'platform/apps/runner/src');
  const files = fs
    .readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts'));

  it.each(files)('%s opens no server', (file) => {
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    expect(source).not.toMatch(/createServer|\.listen\(|node:net'|from 'net'|node:dgram/);
  });
});

describe('driver rules', () => {
  it('needs LiteLLM on the contract egress list', () => {
    expect(llmReachable(CONTRACT, 'http://litellm:4000')).toBe(true);
    expect(llmReachable(CONTRACT, 'http://litellm:4001')).toBe(false);
    expect(
      llmReachable({ ...CONTRACT, egress_allowlist: ['npm-proxy:4873'] }, 'http://litellm:4000'),
    ).toBe(false);
  });

  it.each([
    ['finished', 3, 'finished'],
    ['max_iterations', 3, 'max_iterations'],
    ['stuck', 3, 'stuck'],
    ['stopped', 30, 'max_iterations'],
    ['error', 31, 'max_iterations'],
    ['stopped', 4, 'agent_error'],
    ['error', 4, 'agent_error'],
  ] as const)('an agent %s after %i of 30 steps ends as %s', (state, steps, outcome) => {
    expect(outcomeOf(state, steps, 30)).toBe(outcome);
  });

  it('has a catalog text for every agent error code', () => {
    expect(Object.keys(AGENT_ERROR_MESSAGES).sort()).toEqual([...AGENT_ERROR_CODES].sort());
    for (const code of AGENT_ERROR_CODES) {
      const text = agentErrorMessage(new AgentError(code));
      expect(text).not.toMatch(/\{|agent\.error/);
    }
    expect(new AgentRunError('model_unreachable').message).toContain('model_unreachable');
  });
});
