#!/usr/bin/env node
// Entry point of the runner process (D-03 §5.1, ADR-M25). Settings from the environment; the
// database password from OpenBao (AppRole `runner`); Docker through the socket proxy.
//
// At start the runner cleans up after the previous process, then sweeps at the configured
// interval and writes a heartbeat file after each clean-up (the container health check reads it).
// Runs reach it through the Temporal task queue `sdlc-runner` (C06 session 2, QUESTIONS #53):
// one activity slot per sandbox (`SDLC_RUNNER_MAX_SANDBOXES`), so extra runs wait in Temporal.
import fs from 'node:fs';

import { OpenHandsAdapter } from '@sdlc/adapter-agent-openhands';
import { createJsonLogger, PlatformDatabase, withLogContext } from '@sdlc/core';
import { t } from '@sdlc/messages';
import { OpenBaoClient } from '@sdlc/secrets';
import { activityTracingInterceptor } from '@sdlc/telemetry';

import { RUNNER_TASK_QUEUE } from '@sdlc/contracts';
import { NativeConnection, Worker } from '@temporalio/worker';

import { createRunnerActivities } from './activities.js';
import { DockerClient } from './docker/client.js';
import { RunnerError } from './errors.js';
import { DB_PASSWORD_FIELD, DB_USER, processSettingsFromEnv } from './process.js';
import { Runner } from './runner.js';
import { runnerSettingsFromEnv } from './settings.js';

const APPLICATION_NAME = 'sdlc-runner';

/**
 * JSON lines on stderr (the platform logger, A08, ADR-M35): codes and counts only, never a secret,
 * a path or a Docker message. Lines inside a run's activity carry its tenant_id and run_id.
 */
const logger = createJsonLogger({ write: (line) => process.stderr.write(line) });

function log(
  level: 'info' | 'warn' | 'error',
  event: string,
  message: string,
  fields: Record<string, number> = {},
): void {
  logger.log(level, event, { message, ...fields });
}

async function connectDatabase(
  openbao: OpenBaoClient,
  db: ReturnType<typeof processSettingsFromEnv>['db'],
): Promise<PlatformDatabase> {
  const entry = await openbao.kv().read(db.secretPath);
  const password = entry.data[DB_PASSWORD_FIELD];
  if (!password) throw new RunnerError('runner.start.no_db_password');
  const url = new URL(`postgres://${db.host}:${String(db.port)}/${db.name}`);
  url.username = DB_USER;
  url.password = password.reveal();
  return PlatformDatabase.connect({
    connectionString: url.toString(),
    applicationName: APPLICATION_NAME,
  });
}

async function main(): Promise<void> {
  const settings = runnerSettingsFromEnv(process.env);
  const proc = processSettingsFromEnv(process.env);
  const openbao = OpenBaoClient.fromEnv(process.env, logger);
  await openbao.assertReady();
  const db = await connectDatabase(openbao, proc.db);
  const docker = new DockerClient({ socketPath: settings.dockerSocket });
  await docker.ping();

  const beat = () =>
    fs.writeFileSync(proc.heartbeatFile, new Date().toISOString(), { mode: 0o600 });
  const runner = new Runner(
    { db, docker, settings, verifier: openbao.transit(), unwrapper: openbao.wrapping() },
    {
      onCleanUp: (kind, result) => {
        beat();
        if (result.runs > 0 || result.errors > 0) {
          log(
            result.errors > 0 ? 'warn' : 'info',
            `runner.clean_up.${kind}`,
            t('runner.start.cleaned_up', {
              runs: result.runs,
              failed: result.failedRuns,
              errors: result.errors,
            }),
            { runs: result.runs, failed_runs: result.failedRuns, errors: result.errors },
          );
        }
      },
      onSweepError: (error) =>
        log(
          'warn',
          'runner.sweep_failed',
          t('runner.start.sweep_failed', {
            reason: error instanceof RunnerError ? error.key : 'unknown',
          }),
        ),
    },
    { adapter: new OpenHandsAdapter() },
  );
  await runner.start();

  // The task queue `sdlc-runner` (C06 session 2, ADR-M33 §2.6).
  let temporal:
    { connection: NativeConnection; worker: Worker; running: Promise<void> } | undefined;
  if (proc.temporal) {
    const connection = await NativeConnection.connect({ address: proc.temporal.address });
    const worker = await Worker.create({
      connection,
      namespace: proc.temporal.namespace,
      taskQueue: RUNNER_TASK_QUEUE,
      activities: {
        ...createRunnerActivities({ db, runner, unwrapper: openbao.wrapping(), logger }),
      },
      // The log context (tenant, run) of each activity (A08, ADR-M35 §2.6). No runner traces yet.
      interceptors: { activity: [activityTracingInterceptor({ withLogContext })] },
      maxConcurrentActivityTaskExecutions: settings.maxSandboxes,
    });
    const running = worker.run();
    // A failed Temporal worker stops the process; Compose restarts it (its clean-up then runs).
    running.catch(() => {
      log('error', 'runner.temporal_failed', t('runner.start.temporal_failed'));
      process.exitCode = 1;
      process.kill(process.pid, 'SIGTERM');
    });
    temporal = { connection, worker, running };
  } else {
    log('warn', 'runner.temporal_off', t('runner.start.temporal_off'));
  }
  log(
    'info',
    'runner.started',
    t('runner.start.ready', {
      instance: settings.instance,
      max: settings.maxSandboxes,
    }),
  );

  const shutdown = () => {
    if (temporal?.worker.getState() === 'RUNNING') temporal.worker.shutdown();
    void (temporal?.running.catch(() => undefined) ?? Promise.resolve())
      .then(() => temporal?.connection.close())
      .then(() => runner.stop())
      .then(() => Promise.all([db.close(), openbao.close()]))
      .finally(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

main().catch((error: unknown) => {
  const reason =
    error instanceof RunnerError ? error.message : error instanceof Error ? error.name : 'unknown';
  log('error', 'runner.start_failed', t('runner.start.failed', { reason }));
  process.exitCode = 1;
});
