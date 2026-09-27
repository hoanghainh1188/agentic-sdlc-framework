#!/usr/bin/env node
// Entry point of the worker process (task B06, design/ADR-M27). Today it runs the GitHub poller
// and the escalation clock loop (B11, ADR-M28); B07 adds the Temporal worker with the G1–G8
// workflow. Settings come from the environment, the database password and the GitHub App key
// from OpenBao (AppRole `worker`).
import fs from 'node:fs';

import { GitHubAdapter } from '@sdlc/adapter-git-github';
import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';
import { GitHostError } from '@sdlc/contracts';
import {
  advanceEscalation,
  gitHostErrorMessage,
  loadEffectiveConfig,
  pollProject,
  Registry,
} from '@sdlc/core';
import { t } from '@sdlc/messages';
import { OpenBaoClient, SecretsError } from '@sdlc/secrets';

import { connectDatabase } from './database.js';
import { EscalationLoop } from './escalation-loop.js';
import { jsonLogger } from './logger.js';
import { PollerLoop } from './poller-loop.js';
import { loadSettings, SettingsError } from './settings.js';

const logger = jsonLogger((line) => process.stdout.write(line));

async function main(): Promise<void> {
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
  logger.log('info', 'worker.started', {
    tick_ms: settings.tickMs,
    escalation_tick_ms: settings.escalationTickMs,
  });

  const shutdown = (): void => {
    void Promise.all([loop.stop(), escalations.stop()])
      .then(() => Promise.all([db.close(), openbao.close()]))
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
