#!/usr/bin/env node
// Entry point of the api process (task B03, ADR-M26 section 2.6). Settings from the environment;
// the database password from OpenBao (AppRole `api`), or a URL in dev mode.
// Tracing starts first (A08, ADR-M35): `./telemetry.js` must stay the first import.
import { SERVICE_NAME, tracing, tracingEndpointValid } from './telemetry.js';

import 'reflect-metadata';

import { t } from '@sdlc/messages';
import { OTEL_ENDPOINT_ENV } from '@sdlc/telemetry';
import { connectTemporal, TemporalIntentSignals } from '@sdlc/workflow-client';

import { createApp } from './app.js';
import { connectDatabase } from './database.js';
import { createApiLogger, NestJsonLogger } from './observability/logging.js';
import { loadSettings, SettingsError } from './settings.js';

const log = createApiLogger();

async function main(): Promise<void> {
  if (!tracingEndpointValid) throw new SettingsError('api.settings.invalid', OTEL_ENDPOINT_ENV);
  const settings = loadSettings(process.env);
  if (settings.database.kind === 'dev_url') {
    log.log('warn', 'api.dev_mode', { message: t('api.start.dev_mode') });
  }
  const db = await connectDatabase(settings, process.env);
  // Wakes the intent workflow after a change (B07, ADR-M30).
  const temporal = settings.temporal ? await connectTemporal(settings.temporal) : undefined;
  if (!temporal) log.log('warn', 'api.temporal_off', { message: t('api.start.temporal_off') });
  const app = await createApp({
    db,
    settings,
    log,
    nestLogger: new NestJsonLogger(log),
    ...(temporal ? { intentSignals: new TemporalIntentSignals(temporal.client) } : {}),
  });
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onClose', async () => {
      await temporal?.close();
      await db.close();
      await tracing?.shutdown();
    });
  await app.listen({ host: settings.host, port: settings.port });
  log.log('info', 'api.started', {
    message: t('api.start.listening', { host: settings.host, port: settings.port }),
    service: SERVICE_NAME,
    tracing: tracing !== undefined,
  });
}

main().catch((error: unknown) => {
  const reason =
    error instanceof SettingsError
      ? t(error.key, { name: error.setting })
      : error instanceof Error
        ? error.message
        : String(error);
  log.log('error', 'api.start_failed', { message: t('api.start.failed', { reason }) });
  process.exitCode = 1;
});
