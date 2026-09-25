// Message catalog for the database commands (NFR-08). English only for now; other languages
// add a catalog with the same keys. Moves into the shared catalog once it exists.

export const DB_MESSAGES_EN = {
  'db.migrate.usage':
    'Usage: migrate-cli <latest|status>. Needs SDLC_DB_MIGRATION_URL (owner role).',
  'db.migrate.missingUrl': 'SDLC_DB_MIGRATION_URL is not set.',
  'db.migrate.applied': 'Applied migration {name}.',
  'db.migrate.failedMigration': 'Migration {name} failed; it was rolled back.',
  'db.migrate.upToDate': 'The database is up to date.',
  'db.migrate.failed': 'Migration failed: {reason}',
  'db.status.applied': 'applied  {name}  {executedAt}',
  'db.status.pending': 'pending  {name}',
} as const;

export type DbMessageKey = keyof typeof DB_MESSAGES_EN;

export function dbMessage(key: DbMessageKey, params: Record<string, string> = {}): string {
  return DB_MESSAGES_EN[key].replace(/\{(\w+)\}/g, (match, name: string) => params[name] ?? match);
}
