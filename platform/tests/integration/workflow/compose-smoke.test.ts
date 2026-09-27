// D-08 B07 AC5 smoke test on the real Compose Temporal (design/ADR-M30 §2.7). Needs Docker.
// Skipped unless SDLC_WORKFLOW_COMPOSE_TEST=1. Run with: pnpm test:workflow-compose (CI `compose`).
//
// The time-skipping test server does not hand a stopped worker's sticky tasks to a new worker, so
// the session 1 restart test runs its workers without a workflow cache. This test uses workers
// like the worker process (default cache, sticky queues) on the pinned Compose Temporal: worker 1
// stops while the intent waits at G1, the decision and its signal arrive, and worker 2 continues
// once the server gives the sticky task back to the normal queue (schedule-to-start timeout, 10 s
// by default). Own throw-away Compose project (name, ports +25000, subnet, env file), removed
// afterwards; the platform database is the throw-away PostgreSQL of `test-db.sh`.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { bundleWorkflowCode } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createIntentActivities,
  type IntentActivityDeps,
} from '../../../apps/worker/src/activities/intent-activities.js';
import { startIntentWorker, type IntentWorkerHandle } from '../../../apps/worker/src/temporal.js';
import type { IntentWorkflowRef } from '../../../packages/contracts/src/intent-workflow.js';
import type { Intent } from '../../../packages/core/src/db/schema.js';
import {
  connectTemporal,
  TemporalIntentSignals,
  type TemporalClient,
} from '../../../packages/workflow-client/src/index.js';
import { deployDir } from '../../deploy/compose';
import { createTestDatabase, type TestDatabase } from '../db/helpers.js';
import { isolateEnv } from '../throwaway-compose';
import { createWorkflowFixture, type WorkflowFixture } from './fixture.js';

const enabled = process.env.SDLC_WORKFLOW_COMPOSE_TEST === '1';
const PORT_OFFSET = 25000;
const WORKFLOWS = path.resolve(__dirname, '../../../apps/worker/dist/workflows/index.js');
const T0 = new Date('2026-09-28T01:00:00.000Z');

async function waitFor<T>(
  read: () => Promise<T>,
  ok: (value: T) => boolean,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out; last value ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

describe.skipIf(!enabled)('B07: intent workflow on the Compose Temporal (smoke)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-wf-compose-'));
  const envFile = path.join(tmp, 'it.env');
  const project = `sdlcwf${process.pid}`;
  const subnet = `172.30.${175 + (process.pid % 25)}.0/24`;
  const compose = (...args: string[]) =>
    spawnSync(
      'docker',
      ['compose', '-f', path.join(deployDir, 'docker-compose.yml'), '--env-file', envFile, ...args],
      { encoding: 'utf8' },
    );
  const ok = (r: ReturnType<typeof compose>, what: string) => {
    if (r.status !== 0) throw new Error(`${what} failed (exit ${r.status}): ${r.stderr}`);
  };

  let db: TestDatabase;
  let f: WorkflowFixture;
  let temporal: TemporalClient;
  let signals: TemporalIntentSignals;
  let bundlePath: string;
  const workers: IntentWorkerHandle[] = [];

  const startWorker = async () => {
    const worker = await startIntentWorker({
      settings: { address: `127.0.0.1:${7233 + PORT_OFFSET}`, namespace: 'default' },
      workflowBundlePath: bundlePath,
      activities: createIntentActivities({
        db: db.app as unknown as IntentActivityDeps['db'],
        registry: f.registry as unknown as IntentActivityDeps['registry'],
      }),
    });
    workers.push(worker);
    return worker;
  };
  const ref = (intent: Intent): IntentWorkflowRef => ({
    tenantId: f.target.tenantId,
    intentId: intent.id,
  });
  const atGate = (intent: Intent, gate: string, timeoutMs = 20_000) =>
    waitFor(
      async () => (await f.scope.intents.getById(intent.id))!,
      (i) => i.status === 'in_gate' && i.current_gate === gate,
      timeoutMs,
    );

  beforeAll(async () => {
    const init = spawnSync(path.join(deployDir, 'scripts/init-env.sh'), [envFile], {
      encoding: 'utf8',
    });
    if (init.status !== 0) throw new Error(`init-env failed: ${init.stderr}`);
    fs.writeFileSync(
      envFile,
      isolateEnv(fs.readFileSync(envFile, 'utf8'), {
        project,
        subnet,
        gateway: subnet.replace(/0\/24$/, '1'),
        portOffset: PORT_OFFSET,
      }),
      { mode: 0o600 },
    );
    ok(compose('--profile', 'core', 'up', '-d', '--wait', 'temporal'), 'compose up temporal');
    ok(compose('--profile', 'core', 'run', '--rm', 'temporal-namespace'), 'temporal namespace');

    db = await createTestDatabase();
    f = await createWorkflowFixture(db, () => T0);
    f.h.stub.now = T0;
    const { code } = await bundleWorkflowCode({ workflowsPath: WORKFLOWS });
    bundlePath = path.join(tmp, 'bundle.js');
    fs.writeFileSync(bundlePath, code);
    temporal = await connectTemporal({
      address: `127.0.0.1:${7233 + PORT_OFFSET}`,
      namespace: 'default',
    });
    signals = new TemporalIntentSignals(temporal.client);
  }, 600_000);

  afterAll(async () => {
    for (const worker of workers) await worker.shutdown().catch(() => undefined);
    await temporal?.close();
    await f?.close();
    await db?.drop();
    compose('--profile', 'core', 'down', '-v', '--remove-orphans');
    fs.rmSync(tmp, { recursive: true, force: true });
  }, 300_000);

  it('a worker with a workflow cache stops; a new worker continues the intent', async () => {
    const first = await startWorker();
    const intent = await f.newIntent();
    await signals.wake(ref(intent));
    await atGate(intent, 'G1');

    await first.shutdown();
    f.comment(intent, '/approve G1', 'a');
    await f.poll(signals); // the decision is committed; the signal waits in Temporal
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await f.scope.intents.getById(intent.id))?.current_gate).toBe('G1');

    await startWorker();
    // The sticky task returns to the normal queue after its schedule-to-start timeout.
    await atGate(intent, 'G2', 60_000);
    const notices = await f.scope.intentNotices.listForIntent(intent.id);
    expect(notices.map((n) => n.gate)).toEqual(['G1', 'G2']);
  }, 120_000);
});
