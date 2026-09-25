// A Kysely instance that compiles PostgreSQL but never connects (unit tests, no database).
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';

import type { Database } from '../../packages/core/src/db/schema.js';

export function dummyDb(): Kysely<Database> {
  return new Kysely<Database>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
}

export const TENANT_A = '0a0a0a0a-0000-4000-8000-00000000000a';
export const TENANT_B = '0b0b0b0b-0000-4000-8000-00000000000b';
export const SOME_ID = '0c0c0c0c-0000-4000-8000-00000000000c';
