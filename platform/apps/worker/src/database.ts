// Connects the worker to the platform database as `platform_app` (task B06, ADR-M27 §2.5). The
// password is read once from OpenBao with the `worker` AppRole (`kv/worker/database`, written by
// `openbao:bootstrap worker-credentials`). Dev mode takes a URL instead.
import { PlatformDatabase } from '@sdlc/core';
import type { SecretReader } from '@sdlc/contracts';

import { DB_USER, type WorkerSettings } from './settings.js';

const APPLICATION_NAME = 'sdlc-worker';

/** Field of the KV entry that holds the password. */
export const DB_PASSWORD_FIELD = 'password';

export async function connectDatabase(
  settings: WorkerSettings,
  secrets: SecretReader,
): Promise<PlatformDatabase> {
  const db = settings.database;
  if (db.kind === 'dev_url') {
    return PlatformDatabase.connect({
      connectionString: db.url,
      applicationName: APPLICATION_NAME,
    });
  }
  const entry = await secrets.read(db.secretPath);
  const password = entry.data[DB_PASSWORD_FIELD];
  if (!password) throw new Error(`secret ${db.secretPath} has no ${DB_PASSWORD_FIELD} field`);
  const url = new URL(`postgres://${db.host}:${String(db.port)}/${db.name}`);
  url.username = DB_USER;
  url.password = password.reveal();
  return PlatformDatabase.connect({
    connectionString: url.toString(),
    applicationName: APPLICATION_NAME,
  });
}
