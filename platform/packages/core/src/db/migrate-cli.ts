// `pnpm db:migrate` and `pnpm db:status` (task A06). Operator command, not part of the `sdlc` CLI.
// Reads SDLC_DB_MIGRATION_URL: a URL for the database owner role `platform`.
import { t } from '@sdlc/messages';

import { createKysely } from './connection.js';
import { migrateToLatest, migrationStatus } from './migrator.js';

async function main(command: string | undefined): Promise<number> {
  if (command !== 'latest' && command !== 'status') {
    console.error(t('db.migrate.usage'));
    return 2;
  }
  const connectionString = process.env.SDLC_DB_MIGRATION_URL;
  if (!connectionString) {
    console.error(t('db.migrate.missing_url'));
    return 2;
  }
  const db = createKysely({ connectionString, maxConnections: 1, applicationName: 'sdlc-migrate' });
  try {
    if (command === 'status') {
      for (const m of await migrationStatus(db)) {
        console.log(
          m.executedAt
            ? t('db.status.applied', {
                name: m.name,
                executed_at: m.executedAt.toISOString(),
              })
            : t('db.status.pending', { name: m.name }),
        );
      }
      return 0;
    }
    const { error, results = [] } = await migrateToLatest(db);
    for (const r of results) {
      if (r.status === 'Success') console.log(t('db.migrate.applied', { name: r.migrationName }));
      if (r.status === 'Error')
        console.error(t('db.migrate.failed_migration', { name: r.migrationName }));
    }
    if (error) {
      console.error(t('db.migrate.failed', { reason: errorText(error) }));
      return 1;
    }
    if (results.length === 0) console.log(t('db.migrate.up_to_date'));
    return 0;
  } finally {
    await db.destroy();
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main(process.argv[2]).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(t('db.migrate.failed', { reason: errorText(error) }));
    process.exitCode = 1;
  },
);
