#!/usr/bin/env node
// Entry point of the api process (task B03, ADR-M26 section 2.6). Settings from the environment;
// the database password from OpenBao (AppRole `api`), or a URL in dev mode.
import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { t } from '@sdlc/messages';

import { createApp } from './app.js';
import { connectDatabase } from './database.js';
import { loadSettings, SettingsError } from './settings.js';

const logger = new Logger('sdlc-api');

async function main(): Promise<void> {
  const settings = loadSettings(process.env);
  if (settings.database.kind === 'dev_url') logger.warn(t('api.start.dev_mode'));
  const db = await connectDatabase(settings, process.env);
  const app = await createApp({ db, settings });
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onClose', async () => db.close());
  await app.listen({ host: settings.host, port: settings.port });
  logger.log(t('api.start.listening', { host: settings.host, port: settings.port }));
}

main().catch((error: unknown) => {
  const reason =
    error instanceof SettingsError
      ? t(error.key, { name: error.setting })
      : error instanceof Error
        ? error.message
        : String(error);
  logger.error(t('api.start.failed', { reason }));
  process.exitCode = 1;
});
