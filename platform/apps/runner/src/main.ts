#!/usr/bin/env node
// Entry point of the runner process (D-03 §5.1, ADR-M25). Settings from the environment; the
// database password from OpenBao (AppRole `runner`); Docker through the socket proxy.
//
// At start the runner cleans up after the previous process, then sweeps at the configured
// interval and writes a heartbeat file after each clean-up (the container health check reads it).
// Runs reach it through the Temporal task queue `sdlc-runner` from C06 (QUESTIONS #53).
import fs from 'node:fs';

import { PlatformDatabase } from '@sdlc/core';
import { t } from '@sdlc/messages';
import { OpenBaoClient } from '@sdlc/secrets';

import { DockerClient } from './docker/client.js';
import { RunnerError } from './errors.js';
import { DB_PASSWORD_FIELD, DB_USER, processSettingsFromEnv } from './process.js';
import { Runner } from './runner.js';
import { runnerSettingsFromEnv } from './settings.js';

const APPLICATION_NAME = 'sdlc-runner';

/** One JSON line on stderr: codes and counts only, never a secret, a path or a Docker message. */
function log(level: 'info' | 'warn' | 'error', event: string, message: string, fields = {}): void {
  process.stderr.write(
    `${JSON.stringify({ time: new Date().toISOString(), level, event, message, ...fields })}\n`,
  );
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
  const openbao = OpenBaoClient.fromEnv(process.env);
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
  );
  await runner.start();
  log(
    'info',
    'runner.started',
    t('runner.start.ready', {
      instance: settings.instance,
      max: settings.maxSandboxes,
    }),
  );

  const shutdown = () => {
    void runner
      .stop()
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
