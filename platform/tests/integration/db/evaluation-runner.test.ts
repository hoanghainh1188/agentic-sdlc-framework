// D-08 L04 (PR 4b) on PostgreSQL with the Docker stub (design/ADR-M81 §2.3; ADR-M25 §2.8): the
// sweep and the clean-up at start treat an evaluation run whose runner was lost: its objects are
// removed, the run is queued again for the next attempt (not counted), and after
// `MAX_EVALUATION_ATTEMPTS` it fails with `runner_lost`. A real run's rows are never touched, and a
// run this process holds is left alone.
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import {
  DockerClient,
  HeldRuns,
  MAX_EVALUATION_ATTEMPTS,
  reconcileOnStart,
  runLabels,
  runnerSettingsFromEnv,
  sweepOrphans,
  type RunnerSettings,
} from '../../../apps/runner/src/index.js';
import { StubDocker } from '../../runner/stub-docker.js';
import { seedEvaluation, type SeededEvaluation } from '../evaluation-seed.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

describeDb('L04 PR 4b: the sweep and evaluation runs on PostgreSQL', () => {
  let t: TestDatabase;
  let docker: StubDocker;
  let client: DockerClient;
  let settings: RunnerSettings;
  let tenants = 0;

  beforeAll(async () => {
    t = await createTestDatabase();
    docker = await StubDocker.start();
    client = new DockerClient({ socketPath: docker.socketPath, timeoutMs: 5000 });
    settings = runnerSettingsFromEnv({ SDLC_RUNNER_INSTANCE: 'sdlc' });
  }, 60_000);
  afterAll(async () => {
    await docker?.stop();
    await t?.drop();
  });
  beforeEach(() => {
    docker.calls.length = 0;
    docker.containers.clear();
    docker.networks.clear();
    docker.volumes.clear();
  });

  const seed = () => seedEvaluation(t.app, { slug: `ev-run-${String(++tenants)}` });
  const deps = (): Parameters<typeof sweepOrphans>[0] => ({
    db: t.app as unknown as Parameters<typeof sweepOrphans>[0]['db'],
    docker: client,
    settings,
  });
  /** The leftovers of an evaluation run's scoring or sandbox: its labelled workspace volume. */
  const leave = (w: SeededEvaluation, runId: string) =>
    docker.volumes.set(`sdlc-ws-${runId}`, runLabels('sdlc', runId, w.scope.tenantId));
  const run = (w: SeededEvaluation, id: string) => w.scope.evaluationRuns.getById(id);

  it('queues a lost run again for the next attempt, and removes its objects', async () => {
    const w = await seed();
    expect(await w.scope.evaluationRuns.claim(w.runs[0]!, 1, 'runner-1')).toBe(true);
    leave(w, w.runs[0]!);
    const result = await sweepOrphans(deps(), new HeldRuns());
    expect(result).toEqual({ runs: 1, failedRuns: 1, errors: 0 });
    expect(await run(w, w.runs[0]!)).toMatchObject({
      status: 'queued',
      attempt: 2,
      runner_instance: null,
      started_at: null,
    });
    expect(docker.volumes.size).toBe(0);
    // No result for the lost attempt, and the other run is untouched.
    expect(await w.scope.evaluationRuns.resultsForEvaluation(w.evaluationId)).toEqual([]);
    expect(await run(w, w.runs[1]!)).toMatchObject({ status: 'queued', attempt: 1 });
  });

  it(`fails the run for good after ${String(MAX_EVALUATION_ATTEMPTS)} attempts`, async () => {
    const w = await seed();
    const id = w.runs[0]!;
    for (let attempt = 1; attempt < MAX_EVALUATION_ATTEMPTS; attempt++) {
      expect(await w.scope.evaluationRuns.claim(id, attempt, 'runner-1')).toBe(true);
      leave(w, id);
      await sweepOrphans(deps(), new HeldRuns());
      expect((await run(w, id))!.attempt).toBe(attempt + 1);
    }
    expect(await w.scope.evaluationRuns.claim(id, MAX_EVALUATION_ATTEMPTS, 'runner-1')).toBe(true);
    leave(w, id);
    expect(await sweepOrphans(deps(), new HeldRuns())).toMatchObject({ failedRuns: 1 });
    expect(await run(w, id)).toMatchObject({ status: 'failed', stop_reason: 'runner_lost' });
  });

  it('leaves a run this process holds, and a run that is not running, alone', async () => {
    const w = await seed();
    const [first, second] = w.runs as [string, string];
    await w.scope.evaluationRuns.claim(first, 1, 'runner-1');
    leave(w, first);
    leave(w, second); // objects of a queued run: removed, the run unchanged
    const held = new HeldRuns();
    held.hold(first);
    expect(await sweepOrphans(deps(), held)).toEqual({ runs: 1, failedRuns: 0, errors: 0 });
    expect(await run(w, first)).toMatchObject({ status: 'running', attempt: 1 });
    expect(await run(w, second)).toMatchObject({ status: 'queued', attempt: 1 });
  });

  it('the clean-up at start does the same for every run of the instance', async () => {
    const w = await seed();
    await w.scope.evaluationRuns.claim(w.runs[0]!, 1, 'runner-1');
    await w.scope.evaluationRuns.claim(w.runs[1]!, 1, 'runner-1');
    leave(w, w.runs[0]!);
    leave(w, w.runs[1]!);
    expect(await reconcileOnStart(deps())).toMatchObject({ runs: 2, failedRuns: 2, errors: 0 });
    expect(await run(w, w.runs[0]!)).toMatchObject({ status: 'queued', attempt: 2 });
    expect(await run(w, w.runs[1]!)).toMatchObject({ status: 'queued', attempt: 2 });
  });

  it('never touches the objects or rows of another instance or tenant', async () => {
    const a = await seed();
    const b = await seed();
    await a.scope.evaluationRuns.claim(a.runs[0]!, 1, 'runner-1');
    await b.scope.evaluationRuns.claim(b.runs[0]!, 1, 'runner-1');
    docker.volumes.set(
      `sdlc-ws-${a.runs[0]!}`,
      runLabels('other-instance', a.runs[0]!, a.scope.tenantId),
    );
    expect(await sweepOrphans(deps(), new HeldRuns())).toEqual({
      runs: 0,
      failedRuns: 0,
      errors: 0,
    });
    expect(await run(a, a.runs[0]!)).toMatchObject({ status: 'running' });
    expect(await run(b, b.runs[0]!)).toMatchObject({ status: 'running' });
  });
});
