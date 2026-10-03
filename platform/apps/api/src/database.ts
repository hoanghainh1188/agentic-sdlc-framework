// Connects the api process to the platform database as `platform_app` (task B03, ADR-M26
// section 2.6, D-03 section 8.2). The password is read once from OpenBao with the `api` AppRole.
// B08 (ADR-M39 §2.2): the OpenBao client stays open, because the GitHub adapter of the spec
// endpoints reads the App key again from time to time (ADR-M23 §2.2). Dev mode takes a URL.
import type { SecretReader } from '@sdlc/contracts';
import { PlatformDatabase } from '@sdlc/core';

import { DB_USER, type ApiSettings } from './settings.js';

const APPLICATION_NAME = 'sdlc-api';

/** Field of the KV entry that holds the password (written by `openbao:bootstrap api-credentials`). */
export const DB_PASSWORD_FIELD = 'password';

/** `secrets` is required unless the settings are in dev mode. */
export async function connectDatabase(
  settings: ApiSettings,
  secrets: SecretReader | undefined,
): Promise<PlatformDatabase> {
  const db = settings.database;
  if (db.kind === 'dev_url') {
    return PlatformDatabase.connect({
      connectionString: db.url,
      applicationName: APPLICATION_NAME,
    });
  }
  if (!secrets) throw new Error('OpenBao is required outside dev mode');
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
