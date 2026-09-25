// Throw-away databases for the DB integration tests (task A06, design/ADR-M09 section 2.6).
// SDLC_TEST_DATABASE_URL: superuser URL of a server whose roles come from
// platform/deploy/postgres/init (`pnpm test:db` starts one). Each test file gets its own database.
// The superuser connects with `-c role=…`, so every check runs with the privileges of
// `platform` (owner, migrations) or `platform_app` (application), never as superuser.
import { randomBytes } from 'node:crypto';
import type { Kysely } from 'kysely';
import pg from 'pg';
import { describe } from 'vitest';

import { createKysely } from '../../../packages/core/src/db/connection.js';
import { migrateToLatest } from '../../../packages/core/src/db/migrator.js';
import { PlatformDatabase } from '../../../packages/core/src/db/platform-database.js';
import type { Database } from '../../../packages/core/src/db/schema.js';

const baseUrl = process.env.SDLC_TEST_DATABASE_URL;
if (!baseUrl && process.env.SDLC_REQUIRE_DB === '1') {
  throw new Error('SDLC_REQUIRE_DB=1 but SDLC_TEST_DATABASE_URL is not set (run: pnpm test:db)');
}

/** `describe` that runs only when a test database server is available. */
export const describeDb = describe.skipIf(!baseUrl);

const TEST_DB_NAME = /^sdlc_test_[0-9a-f]{16}$/;

export function urlFor(database: string, role?: string): string {
  const url = new URL(baseUrl!);
  url.pathname = `/${database}`;
  url.search = role ? `?options=${encodeURIComponent(`-c role=${role}`)}` : '';
  return url.toString();
}

async function admin<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: urlFor('postgres') });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

export interface TestDatabase {
  readonly name: string;
  /** Connected as the owner role `platform`, like the migration command. */
  readonly owner: Kysely<Database>;
  /** Raw query builder connected as `platform_app`, for privilege checks. */
  readonly appRaw: Kysely<Database>;
  /** The data access layer, connected as `platform_app`. */
  readonly app: PlatformDatabase;
  drop(): Promise<void>;
}

/** Creates an empty database owned by `platform` and migrates it to the latest version. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `sdlc_test_${randomBytes(8).toString('hex')}`;
  // The name is interpolated into DDL (identifiers cannot be parameters): check it first.
  if (!TEST_DB_NAME.test(name)) throw new Error(`unexpected test database name ${name}`);
  await admin(async (client) => {
    await client.query(`CREATE DATABASE ${name} OWNER platform`);
    await client.query(`REVOKE ALL ON DATABASE ${name} FROM PUBLIC`);
    await client.query(`GRANT CONNECT ON DATABASE ${name} TO platform_app`);
  });
  const owner = createKysely({ connectionString: urlFor(name, 'platform'), maxConnections: 2 });
  const { error } = await migrateToLatest(owner);
  if (error) throw new Error('migration of the test database failed', { cause: error });
  const appRaw = createKysely({
    connectionString: urlFor(name, 'platform_app'),
    maxConnections: 2,
  });
  const app = PlatformDatabase.connect({
    connectionString: urlFor(name, 'platform_app'),
    maxConnections: 4,
  });
  return {
    name,
    owner,
    appRaw,
    app,
    async drop() {
      await Promise.all([owner.destroy(), appRaw.destroy(), app.close()]);
      if (!TEST_DB_NAME.test(name)) throw new Error(`refusing to drop ${name}`);
      await admin((client) => client.query(`DROP DATABASE ${name} WITH (FORCE)`));
    },
  };
}
