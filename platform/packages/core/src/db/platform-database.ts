// Entry point of the data access layer (task A06).
import type { Kysely } from 'kysely';

import { createKysely, type DatabaseConfig } from './connection.js';
import type { Database } from './schema.js';
import { SystemScope } from './system-scope.js';
import { TenantScope } from './tenant-scope.js';
import type { TenantId } from './tenant-id.js';

/**
 * The platform database, connected as the application role `platform_app`.
 * Tenant data: `forTenant(tenantId)`. The few cross-tenant operations: `system`.
 * The underlying query builder is not exposed.
 */
export class PlatformDatabase {
  readonly system: SystemScope;

  private constructor(private readonly db: Kysely<Database>) {
    this.system = new SystemScope(db);
  }

  static connect(config: DatabaseConfig): PlatformDatabase {
    return new PlatformDatabase(createKysely(config));
  }

  forTenant(tenantId: TenantId): TenantScope {
    return new TenantScope(this.db, tenantId);
  }

  close(): Promise<void> {
    return this.db.destroy();
  }
}
