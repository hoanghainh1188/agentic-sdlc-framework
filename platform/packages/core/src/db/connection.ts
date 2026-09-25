// PostgreSQL connections for the platform database (task A06, design/ADR-M09).
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

import type { Database } from './schema.js';

export interface DatabaseConfig {
  /**
   * `postgres://…` URL. The platform connects as `platform_app`; migrations as `platform`
   * (the owner). Until A04 the URL comes from the environment; later from OpenBao (D-03 §8.2).
   */
  readonly connectionString: string;
  /** Pool size. Default 10. */
  readonly maxConnections?: number;
  readonly applicationName?: string;
}

/** SQL `date` stays a `YYYY-MM-DD` string; a JS Date would shift it by the local time zone. */
const typeParsers: pg.CustomTypesConfig = {
  getTypeParser: (oid, format) =>
    oid === pg.types.builtins.DATE && format !== 'binary'
      ? (value: string) => value
      : (pg.types.getTypeParser(oid, format) as (value: string) => unknown),
};

export function createPool(config: DatabaseConfig): pg.Pool {
  return new pg.Pool({
    connectionString: config.connectionString,
    max: config.maxConnections ?? 10,
    application_name: config.applicationName ?? 'sdlc-platform',
    types: typeParsers,
  });
}

/** Internal: a Kysely instance without the tenant guard. Never exported from `@sdlc/core`. */
export function createKysely(config: DatabaseConfig): Kysely<Database> {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool: createPool(config) }) });
}
