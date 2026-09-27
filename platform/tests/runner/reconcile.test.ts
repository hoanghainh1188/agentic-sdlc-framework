// D-08 C04 AC5, ADR-M25 §2.8: what the clean-up after a crash and the sweep may touch. The runner
// trusts the `sdlc.*` labels only on objects that carry its own instance label; objects of another
// runner instance or with malformed labels are never touched. Database behaviour (run status and
// events) is tested on PostgreSQL in integration/db/runner-reconcile.test.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  DockerClient,
  findRunObjects,
  HeldRuns,
  LABELS,
  MANAGED_BY,
  processSettingsFromEnv,
  RunnerError,
  runLabels,
  runOfLabels,
} from '../../apps/runner/src/index.js';
import { RUN_ID, settings, TENANT_ID } from './helpers';
import { StubDocker } from './stub-docker';

const OTHER_RUN = '22222222-2222-4222-8222-222222222222';
const THIRD_RUN = '44444444-4444-4444-8444-444444444444';

describe('runOfLabels', () => {
  const labels = runLabels('sdlc', RUN_ID, TENANT_ID);

  it('reads the run and tenant of this instance', () => {
    expect(runOfLabels(labels, 'sdlc')).toEqual({ runId: RUN_ID, tenantId: TENANT_ID });
  });

  it.each([
    ['another instance', { ...labels, [LABELS.instance]: 'other' }],
    ['no instance label', { ...labels, [LABELS.instance]: undefined }],
    ['not managed by the runner', { ...labels, [LABELS.managed]: 'someone' }],
    ['a run ID that is not a UUID', { ...labels, [LABELS.runId]: '../etc' }],
    ['an upper-case run ID', { ...labels, [LABELS.runId]: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' }],
    ['a missing tenant', { ...labels, [LABELS.tenantId]: undefined }],
  ])('ignores an object with %s', (_, bad) => {
    expect(runOfLabels(bad as Record<string, string>, 'sdlc')).toBeUndefined();
  });

  it('ignores objects without labels', () => {
    expect(runOfLabels(null, 'sdlc')).toBeUndefined();
    expect(runOfLabels(undefined, 'sdlc')).toBeUndefined();
  });
});

describe('HeldRuns', () => {
  it('holds a run once until it is released', () => {
    const held = new HeldRuns();
    expect(held.hold(RUN_ID)).toBe(true);
    expect(held.hold(RUN_ID)).toBe(false);
    expect(held.has(RUN_ID)).toBe(true);
    held.release(RUN_ID);
    expect(held.has(RUN_ID)).toBe(false);
    expect(held.hold(RUN_ID)).toBe(true);
    expect(held.size).toBe(1);
  });
});

describe('findRunObjects (stub Docker)', () => {
  let stub: StubDocker;
  let docker: DockerClient;

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
  });

  it('groups objects by run, for this instance only', async () => {
    stub.volumes.set(`sdlc-ws-${RUN_ID}`, runLabels('sdlc', RUN_ID, TENANT_ID));
    stub.networks.set(`sdlc-run-${RUN_ID}`, {
      labels: runLabels('sdlc', RUN_ID, TENANT_ID),
      attached: new Set(),
    });
    // Only a reserved volume (crash between the reservation and the claim).
    stub.volumes.set(`sdlc-ws-${THIRD_RUN}`, runLabels('sdlc', THIRD_RUN, TENANT_ID));
    // Another runner deployment on the same Docker host: never touched.
    stub.volumes.set(`sdlc-ws-${OTHER_RUN}`, runLabels('staging', OTHER_RUN, TENANT_ID));
    // Right instance, but not managed by the runner.
    stub.volumes.set('someone-else', {
      [LABELS.instance]: 'sdlc',
      [LABELS.runId]: OTHER_RUN,
      [LABELS.tenantId]: TENANT_ID,
    });
    // Managed, right instance, malformed run ID.
    stub.volumes.set('bad-labels', {
      [LABELS.managed]: MANAGED_BY,
      [LABELS.instance]: 'sdlc',
      [LABELS.runId]: 'not-a-uuid',
      [LABELS.tenantId]: TENANT_ID,
    });

    const runs = await findRunObjects(docker, 'sdlc');
    expect(runs).toHaveLength(2);
    expect(runs).toEqual(
      expect.arrayContaining([
        { runId: RUN_ID, tenantId: TENANT_ID },
        { runId: THIRD_RUN, tenantId: TENANT_ID },
      ]),
    );
    // The list calls ask Docker for this instance's objects only.
    const lists = stub.calls.filter((c) => c.method === 'GET');
    expect(lists.map((c) => c.path).sort()).toEqual(['/containers/json', '/networks', '/volumes']);
    for (const call of lists) {
      expect(JSON.parse(call.query.filters!)).toEqual({
        label: [`${LABELS.managed}=${MANAGED_BY}`, `${LABELS.instance}=sdlc`],
      });
    }
  });
});

describe('runner process and sweep settings', () => {
  it('sweeps every 300 seconds by default, 30–3600 seconds', () => {
    expect(settings().sweepIntervalMs).toBe(300_000);
    expect(settings({ SDLC_RUNNER_SWEEP_INTERVAL_SECONDS: '30' }).sweepIntervalMs).toBe(30_000);
    for (const bad of ['29', '3601', '1e3', '-5']) {
      expect(() => settings({ SDLC_RUNNER_SWEEP_INTERVAL_SECONDS: bad })).toThrow(RunnerError);
    }
  });

  it('reads the database location and heartbeat file; never a password', () => {
    const p = processSettingsFromEnv({});
    expect(p.db).toEqual({
      host: 'postgres',
      port: 5432,
      name: 'platform',
      secretPath: 'runner/database',
    });
    expect(p.heartbeatFile).toMatch(/sdlc-runner-heartbeat$/);
    expect(Object.keys(p.db)).not.toContain('password');
  });

  it.each([
    ['SDLC_RUNNER_DB_SECRET_PATH', 'api/database'], // another AppRole's path
    ['SDLC_RUNNER_DB_SECRET_PATH', 'runner/../api'],
    ['SDLC_RUNNER_DB_PORT', '70000'],
    ['SDLC_RUNNER_DB_NAME', 'Platform;drop'],
    ['SDLC_RUNNER_DB_HOST', 'user@postgres'],
    ['SDLC_RUNNER_HEARTBEAT_FILE', 'relative/file'],
  ])('refuses %s=%s', (name, value) => {
    expect(() => processSettingsFromEnv({ [name]: value })).toThrow(RunnerError);
  });
});
