import type { Kysely } from 'kysely';

import { translatePgError } from '../errors.js';
import type { Database } from '../schema.js';
import type { TenantId } from '../tenant-id.js';

/**
 * Base of every tenant repository. `db` carries the tenant guard, so a query that forgets the
 * tenant condition fails before it reaches PostgreSQL. Every method still adds the condition itself.
 */
export abstract class TenantRepository {
  constructor(
    protected readonly db: Kysely<Database>,
    readonly tenantId: TenantId,
  ) {}

  /** Runs a statement and maps constraint violations to `DbError`. */
  protected async run<T>(statement: Promise<T>): Promise<T> {
    try {
      return await statement;
    } catch (error) {
      return translatePgError(error);
    }
  }
}
