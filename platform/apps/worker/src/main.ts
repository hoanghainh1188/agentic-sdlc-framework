#!/usr/bin/env node
// Entry point of the worker process (task B06, design/ADR-M27). It runs the GitHub poller, the
// escalation clock loop (B11, ADR-M28), and the Temporal worker of the intent workflow with its
// reconcile loop (B07, ADR-M30). Settings come from the environment, the database password and the
// GitHub App key from OpenBao (AppRole `worker`).
// Tracing starts first (A08, ADR-M35): `./telemetry.js` must stay the first import.
import { tracing, tracingEndpointValid } from './telemetry.js';

import fs from 'node:fs';

import { GitHubAdapter } from '@sdlc/adapter-git-github';
import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';
import { GitHostError, type IntentWorkflowSignals } from '@sdlc/contracts';
import {
  advanceEscalation,
  gitHostErrorMessage,
  loadEffectiveConfig,
  pollProject,
  Registry,
} from '@sdlc/core';
import { t } from '@sdlc/messages';
import { OpenBaoClient, SecretsError } from '@sdlc/secrets';
import { OTEL_ENDPOINT_ENV } from '@sdlc/telemetry';
import {
  connectTemporal,
  NO_INTENT_SIGNALS,
  TemporalIntentSignals,
  type TemporalClient,
} from '@sdlc/workflow-client';

import { connectDatabase } from './database.js';
import { createIntentActivities } from './activities/intent-activities.js';
import { EscalationLoop } from './escalation-loop.js';
import { jsonLogger } from './logger.js';
import { PollerLoop } from './poller-loop.js';
import { ReconcileLoop } from './reconcile-loop.js';
import { createWorkerRuns, type WorkerRuns } from './runs.js';
import { loadSettings, SettingsError } from './settings.js';
import { installTemporalLogging, startIntentWorker, type IntentWorkerHandle } from './temporal.js';

const logger = jsonLogger((line) => process.stdout.write(line));

async function main(): Promise<void> {
  if (!tracingEndpointValid) {
    throw new SettingsError('worker.settings.invalid', OTEL_ENDPOINT_ENV);
  }
  const settings = loadSettings(process.env);
  if (settings.database.kind === 'dev_url') {
    logger.log('warn', 'worker.dev_mode', { message: t('worker.start.dev_mode') });
  }
  // Kept open: the GitHub adapter reads the App key again every 10 minutes (ADR-M23 §2.2).
  const openbao = OpenBaoClient.fromEnv(process.env, logger);
  await openbao.assertReady();
  const secrets = openbao.kv();
  const db = await connectDatabase(settings, secrets);
  const gitHost = new GitHubAdapter({ secrets, apiUrl: settings.githubApiUrl, logger });
  const registry = new Registry({
    policyFactory: (config) => createSimplePolicyEngine({ config }),
  });

  // Agent runs (C06 session 2, ADR-M33 §2.5): the cost-controller AppRole, the gateway and the
  // handoff. Without them a decided G4 waits.
  let workerRuns: WorkerRuns | undefined;
  // The Compose file always names the files; until `openbao:bootstrap worker-credentials` wrote
  // them, the worker starts with runs off instead of failing.
  if (settings.runs && fs.existsSync(settings.runs.costRoleIdFile)) {
    workerRuns = await createWorkerRuns({
      settings: settings.runs,
      env: process.env,
      db,
      registry,
      gitHost,
      signer: openbao.transit(),
      wrapper: openbao.wrapping(),
      logger,
    });
  } else if (settings.temporal) {
    logger.log('warn', 'worker.runs_off', { message: t('worker.start.runs_off') });
  }

  // The intent workflow (B07, ADR-M30): Temporal worker, wake signals and the reconcile loop.
  let temporal: TemporalClient | undefined;
  let intentWorker: IntentWorkerHandle | undefined;
  let signals: IntentWorkflowSignals = NO_INTENT_SIGNALS;
  if (settings.temporal) {
    installTemporalLogging(logger);
    temporal = await connectTemporal(settings.temporal);
    signals = new TemporalIntentSignals(temporal.client);
    intentWorker = await startIntentWorker({
      settings: settings.temporal,
      activities: createIntentActivities({
        db,
        registry,
        ...(workerRuns ? { g4: workerRuns.g4, runs: workerRuns.runs } : {}),
      }),
      workflowBundlePath: settings.workflowBundle,
    });
    // A failed Temporal worker stops the process; Compose restarts it.
    intentWorker.running.catch(() => {
      logger.log('error', 'worker.temporal_failed', {});
      process.exitCode = 1;
      process.kill(process.pid, 'SIGTERM');
    });
  } else {
    logger.log('warn', 'worker.temporal_off', { message: t('worker.start.temporal_off') });
  }

  const loop = new PollerLoop({
    listProjects: () => db.system.listPollableProjects(),
    intervalSeconds: async (project) => {
      const scope = db.forTenant(project.tenantId);
      const { config } = await loadEffectiveConfig(scope.projectConfigs, project.projectId);
      return config.github.poll_interval_seconds;
    },
    poll: (project) =>
      pollProject(
        {
          db,
          gitHost,
          registry,
          logger,
          maxReplyAttempts: settings.maxReplyAttempts,
          maxEventAttempts: settings.maxEventAttempts,
          intentSignals: signals,
        },
        project,
      ),
    now: () => Date.now(),
    logger,
    maxConcurrentPolls: settings.maxConcurrentPolls,
    heartbeat: () => fs.writeFileSync(settings.heartbeatFile, ''),
  });
  loop.start(settings.tickMs);
  // The escalation clocks (B11, ADR-M28): state in PostgreSQL, no Temporal timers.
  const escalations = new EscalationLoop({
    listDue: (now, limit) => db.system.listDueEscalations(now, limit),
    advance: (due, now) => advanceEscalation(db.forTenant(due.tenantId), due.escalationId, now),
    now: () => new Date(),
    logger,
    batchSize: settings.escalationBatch,
  });
  escalations.start(settings.escalationTickMs);
  const reconcile = settings.temporal
    ? new ReconcileLoop({
        listOpen: (limit, after) => db.system.listOpenIntents(limit, after),
        signals,
        logger,
        batchSize: settings.reconcileBatch,
      })
    : undefined;
  reconcile?.start(settings.reconcileMs);
  logger.log('info', 'worker.started', {
    tick_ms: settings.tickMs,
    escalation_tick_ms: settings.escalationTickMs,
    tracing: tracing !== undefined,
  });

  const shutdown = (): void => {
    void Promise.all([loop.stop(), escalations.stop(), reconcile?.stop(), intentWorker?.shutdown()])
      .then(() =>
        Promise.all([
          db.close(),
          openbao.close(),
          temporal?.close(),
          workerRuns?.close(),
          tracing?.shutdown(),
        ]),
      )
      .then(() => logger.log('info', 'worker.stopped', {}));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

/** Catalog text for the known errors; only the error name otherwise (no library text). */
function failureReason(error: unknown): string {
  if (error instanceof SettingsError) return t(error.key, { name: error.setting });
  // Both messages come from the catalog and hold safe parameters only.
  if (error instanceof SecretsError) return error.message;
  if (error instanceof GitHostError) return gitHostErrorMessage(error);
  return error instanceof Error ? error.name : 'unexpected';
}

main().catch((error: unknown) => {
  const reason = failureReason(error);
  logger.log('error', 'worker.failed', { message: t('worker.failed', { reason }) });
  process.exitCode = 1;
});
