// All migrations, in order. Add new ones at the end; never rename, reorder or edit a merged one.
// A static list (no directory scan, no computed import) keeps the build simple and reviewable.
import { migration0001Tenancy } from './0001-tenancy.js';
import { migration0002AuditLog } from './0002-audit-log.js';
import { migration0003Registry } from './0003-registry.js';
import { migration0004Runs } from './0004-runs.js';
import type { SqlMigration } from './define.js';

export const MIGRATIONS: Readonly<Record<string, SqlMigration>> = {
  '0001-tenancy': migration0001Tenancy,
  '0002-audit-log': migration0002AuditLog,
  '0003-registry': migration0003Registry,
  '0004-runs': migration0004Runs,
};
