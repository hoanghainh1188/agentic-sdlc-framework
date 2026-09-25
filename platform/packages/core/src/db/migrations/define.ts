import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

export interface SqlMigration extends Migration {
  /** The SQL statements, in order. Exposed for tests and review. */
  readonly statements: { readonly up: readonly string[]; readonly down: readonly string[] };
}

/**
 * A migration made of plain SQL statements. Statements run one by one (the `pg` driver sends
 * each as one prepared statement); the migrator wraps the whole migration in one transaction.
 * `down` is for development only; production migrations only go forward (ADR-M09).
 */
export function defineMigration(statements: {
  up: readonly string[];
  down: readonly string[];
}): SqlMigration {
  const run = async (db: Kysely<unknown>, list: readonly string[]) => {
    for (const statement of list) await sql.raw(statement).execute(db);
  };
  return {
    statements,
    up: (db) => run(db, statements.up),
    down: (db) => run(db, statements.down),
  };
}
