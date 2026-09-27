// Connects the api process to the platform database as `platform_app` (task B03, ADR-M26
// section 2.6, D-03 section 8.2). The password is read once from OpenBao with the `api` AppRole;
// the OpenBao client is closed afterwards (its token is revoked). Dev mode takes a URL instead.
import { PlatformDatabase } from '@sdlc/core';
import { OpenBaoClient } from '@sdlc/secrets';

import { DB_USER, type ApiSettings } from './settings.js';

const APPLICATION_NAME = 'sdlc-api';

/** Field of the KV entry that holds the password (written by `openbao:bootstrap api-credentials`). */
export const DB_PASSWORD_FIELD = 'password';

export async function connectDatabase(
  settings: ApiSettings,
  env: NodeJS.ProcessEnv,
): Promise<PlatformDatabase> {
  const db = settings.database;
  if (db.kind === 'dev_url') {
    return PlatformDatabase.connect({
      connectionString: db.url,
      applicationName: APPLICATION_NAME,
    });
  }
  const openbao = OpenBaoClient.fromEnv(env);
  try {
    await openbao.assertReady();
    const entry = await openbao.kv().read(db.secretPath);
    const password = entry.data[DB_PASSWORD_FIELD];
    if (!password) throw new Error(`secret ${db.secretPath} has no ${DB_PASSWORD_FIELD} field`);
    const url = new URL(`postgres://${db.host}:${String(db.port)}/${db.name}`);
    url.username = DB_USER;
    url.password = password.reveal();
    return PlatformDatabase.connect({
      connectionString: url.toString(),
      applicationName: APPLICATION_NAME,
    });
  } finally {
    await openbao.close();
  }
}
