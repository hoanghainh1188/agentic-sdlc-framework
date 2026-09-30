// C06 session 2 (D-08 C06 AC4, ADR-M33 §2.6): the runner's Temporal activity `executeRun` and the
// process settings of its task queue, without Docker or Temporal. Live: `pnpm test:workflow`.
import { describe, expect, it } from 'vitest';

import {
  createRunnerActivities,
  type ActivityContextLike,
} from '../../apps/runner/src/activities.js';
import { processSettingsFromEnv } from '../../apps/runner/src/index.js';
import { createJsonLogger, withLogContext } from '../../packages/core/src/observability/index.js';
import { activityTracingInterceptor } from '../../packages/telemetry/src/index.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';

function harness(
  options: {
    provisionOk?: boolean;
    unwrapFails?: boolean;
    runStatus?: string;
    agentWaitsForCancel?: boolean;
  } = {},
) {
  const calls: string[] = [];
  let status = options.runStatus ?? 'succeeded';
  const scope = {
    runContracts: {
      getByRunId: (id: string) =>
        Promise.resolve(
          id === RUN ? { contract_json: { run_id: RUN }, signature: 'vault:v1:x' } : undefined,
        ),
    },
    runs: {
      getById: () =>
        Promise.resolve({ status, stop_reason: status === 'failed' ? 'key_unavailable' : null }),
      transition: (_id: string, change: { to: string }) => {
        calls.push(`transition:${change.to}`);
        status = change.to;
        return Promise.resolve(true);
      },
    },
  };
  const abort = new AbortController();
  const lines: string[] = [];
  let beats = 0;
  const ctx: ActivityContextLike = {
    heartbeat: () => {
      beats += 1;
    },
    cancellationSignal: abort.signal,
  };
  const activities = createRunnerActivities({
    db: { forTenant: () => scope } as never,
    runner: {
      provision: (request) => {
        calls.push(`provision:${(request.envelope as { signature: string }).signature}`);
        return Promise.resolve(
          options.provisionOk === false
            ? { ok: false, reason: 'expired', runId: RUN }
            : ({ ok: true, contract: { run_id: RUN }, sandbox: {} } as never),
        );
      },
      runAgent: (request) => {
        calls.push(`runAgent:${request.model}:${request.virtualKey.reveal()}`);
        if (!options.agentWaitsForCancel) return Promise.resolve({} as never);
        // The driver stops the agent when the signal is aborted, then the sandbox is removed.
        return new Promise((resolve) =>
          request.signal?.addEventListener('abort', () => {
            calls.push('agent_stopped');
            calls.push('release:killed');
            resolve({} as never);
          }),
        );
      },
      release: (_tenant, _run, reason) => {
        calls.push(`release:${reason}`);
        return Promise.resolve();
      },
    },
    unwrapper: {
      unwrap: (token) =>
        options.unwrapFails
          ? Promise.reject(new Error('used'))
          : Promise.resolve({ key: { reveal: () => `key-of-${token.reveal()}` } }),
    },
    context: () => ctx,
    heartbeatMs: 5,
    logger: createJsonLogger({ write: (line) => lines.push(line) }),
  });
  const input = {
    tenantId: TENANT,
    runId: RUN,
    modelRef: 'gpt-oss-20b',
    wrappedGitToken: 'wrap-git',
    wrappedVirtualKey: 'wrap-key',
  };
  return { activities, calls, input, abort, lines, beats: () => beats };
}

describe('executeRun', () => {
  it('provisions from the stored contract, unwraps the key, drives the agent, returns codes', async () => {
    const h = harness();
    const result = await h.activities.executeRun(h.input);
    expect(result).toEqual({ outcome: 'ended', status: 'succeeded', stopReason: null });
    expect(h.calls).toEqual(['provision:vault:v1:x', 'runAgent:gpt-oss-20b:key-of-wrap-key']);
    expect(h.beats()).toBeGreaterThanOrEqual(1);
  });

  it('A08 AC1: through the activity interceptor, its log lines carry tenant_id and run_id', async () => {
    const h = harness();
    const { inbound } = activityTracingInterceptor({ withLogContext })({
      info: { activityType: 'executeRun', attempt: 1, taskQueue: 'sdlc-runner' },
    });
    await inbound.execute({ args: [h.input] }, (input) =>
      h.activities.executeRun(input.args[0] as typeof h.input),
    );
    const entries = h.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries).toEqual([
      expect.objectContaining({ event: 'runner.run_started', tenant_id: TENANT, run_id: RUN }),
      expect.objectContaining({
        event: 'runner.run_ended',
        tenant_id: TENANT,
        run_id: RUN,
        outcome: 'ended',
        status: 'succeeded',
        stop_reason: '',
      }),
    ]);
    // Never the wrapping tokens or the key.
    expect(h.lines.join('')).not.toMatch(/wrap-|key-of/);
  });

  it('a refused contract (for example expired) is returned as refused, with its code', async () => {
    const h = harness({ provisionOk: false });
    expect(await h.activities.executeRun(h.input)).toEqual({
      outcome: 'refused',
      reason: 'expired',
    });
    expect(h.calls).toEqual(['provision:vault:v1:x']);
  });

  it('an unknown run is refused without touching Docker', async () => {
    const h = harness();
    expect(await h.activities.executeRun({ ...h.input, runId: TENANT })).toEqual({
      outcome: 'refused',
      reason: 'unknown_contract',
    });
    expect(h.calls).toEqual([]);
  });

  it('a virtual key someone else opened fails the run and removes the sandbox', async () => {
    const h = harness({ unwrapFails: true });
    const result = await h.activities.executeRun(h.input);
    expect(result).toEqual({ outcome: 'ended', status: 'failed', stopReason: 'key_unavailable' });
    expect(h.calls).toEqual(['provision:vault:v1:x', 'release:failed', 'transition:failed']);
  });

  it('a cancel stops the agent through the driver, then the sandbox is removed (no race)', async () => {
    const h = harness({ agentWaitsForCancel: true });
    const running = h.activities.executeRun(h.input);
    await new Promise((resolve) => setTimeout(resolve, 20));
    h.abort.abort();
    await running;
    expect(h.calls.slice(-2)).toEqual(['agent_stopped', 'release:killed']);
  });

  it('a cancel before the agent starts ends the run without driving it', async () => {
    const h = harness();
    h.abort.abort();
    const result = await h.activities.executeRun(h.input);
    expect(h.calls).toEqual(['provision:vault:v1:x', 'release:killed', 'transition:failed']);
    expect(result).toMatchObject({ outcome: 'ended' });
  });
});

describe('runner process settings: the task queue sdlc-runner', () => {
  it('defaults to the Compose Temporal; off takes no runs', () => {
    expect(processSettingsFromEnv({}).temporal).toEqual({
      address: 'temporal:7233',
      namespace: 'default',
    });
    expect(processSettingsFromEnv({ SDLC_RUNNER_TEMPORAL_ADDRESS: 'off' }).temporal).toBeNull();
  });

  it.each([
    ['SDLC_RUNNER_TEMPORAL_ADDRESS', 'http://temporal:7233'],
    ['SDLC_RUNNER_TEMPORAL_ADDRESS', 'temporal'],
    ['SDLC_RUNNER_TEMPORAL_NAMESPACE', 'a b'],
  ])('refuses %s=%s', (name, value) => {
    expect(() => processSettingsFromEnv({ [name]: value })).toThrow(
      expect.objectContaining({ key: 'runner.config.invalid_setting' }),
    );
  });
});
