// Runs the platform migrations (design/ADR-M09). Connect as the database owner (`platform`),
// never as `platform_app`. Production: run after a backup (D-05 section 11).
import type { Kysely } from 'kysely';
import { Migrator, type MigrationResultSet } from 'kysely/migration';

import { MIGRATIONS } from './migrations/index.js';
import type { Database } from './schema.js';

export interface MigrationState {
  readonly name: string;
  readonly executedAt: Date | undefined;
}

function migrator(db: Kysely<Database>): Migrator {
  return new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(MIGRATIONS) },
    // Migrations are applied strictly in order; an unknown applied migration is an error.
    allowUnorderedMigrations: false,
  });
}

/** Applies every pending migration. Each migration runs in its own transaction. */
export function migrateToLatest(db: Kysely<Database>): Promise<MigrationResultSet> {
  return migrator(db).migrateToLatest();
}

/** Development only: reverts the latest migration. */
export function migrateDown(db: Kysely<Database>): Promise<MigrationResultSet> {
  return migrator(db).migrateDown();
}

export async function migrationStatus(db: Kysely<Database>): Promise<MigrationState[]> {
  const list = await migrator(db).getMigrations();
  return list.map((m) => ({ name: m.name, executedAt: m.executedAt }));
}
