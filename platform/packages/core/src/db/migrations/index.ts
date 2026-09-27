// All migrations, in order. Add new ones at the end; never rename, reorder or edit a merged one.
// A static list (no directory scan, no computed import) keeps the build simple and reviewable.
import { migration0001Tenancy } from './0001-tenancy.js';
import { migration0002AuditLog } from './0002-audit-log.js';
import { migration0003Registry } from './0003-registry.js';
import { migration0004Runs } from './0004-runs.js';
import { migration0005CostRecords } from './0005-cost-records.js';
import { migration0006GitEventReceipts } from './0006-git-event-receipts.js';
import { migration0007Escalations } from './0007-escalations.js';
import { migration0008Agents } from './0008-agents.js';
import type { SqlMigration } from './define.js';

export const MIGRATIONS: Readonly<Record<string, SqlMigration>> = {
  '0001-tenancy': migration0001Tenancy,
  '0002-audit-log': migration0002AuditLog,
  '0003-registry': migration0003Registry,
  '0004-runs': migration0004Runs,
  '0005-cost-records': migration0005CostRecords,
  '0006-git-event-receipts': migration0006GitEventReceipts,
  '0007-escalations': migration0007Escalations,
  '0008-agents': migration0008Agents,
};
