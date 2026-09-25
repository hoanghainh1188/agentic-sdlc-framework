// All migrations, in order. Add new ones at the end; never rename, reorder or edit a merged one.
// A static list (no directory scan, no computed import) keeps the build simple and reviewable.
import { migration0001Tenancy } from './0001-tenancy.js';
import { migration0002AuditLog } from './0002-audit-log.js';
import type { SqlMigration } from './define.js';

export const MIGRATIONS: Readonly<Record<string, SqlMigration>> = {
  '0001-tenancy': migration0001Tenancy,
  '0002-audit-log': migration0002AuditLog,
};
