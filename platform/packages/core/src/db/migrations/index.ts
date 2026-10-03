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
import { migration0009IntentWorkflow } from './0009-intent-workflow.js';
import { migration0010AiRecord } from './0010-ai-record.js';
import { migration0011GateG4 } from './0011-gate-g4.js';
import { migration0012EvidenceItems } from './0012-evidence-items.js';
import { migration0013GateG5Runner } from './0013-gate-g5-runner.js';
import { migration0014AdminOnboarding } from './0014-admin-onboarding.js';
import { migration0015GateG5 } from './0015-gate-g5.js';
import { migration0016AgentApprovals } from './0016-agent-approvals.js';
import { migration0017PushedHead } from './0017-pushed-head.js';
import { migration0018PlanFiles } from './0018-plan-files.js';
import { migration0019GateG7 } from './0019-gate-g7.js';
import { migration0020KillSwitch } from './0020-kill-switch.js';
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
  '0009-intent-workflow': migration0009IntentWorkflow,
  '0010-ai-record': migration0010AiRecord,
  '0011-gate-g4': migration0011GateG4,
  '0012-evidence-items': migration0012EvidenceItems,
  '0013-gate-g5-runner': migration0013GateG5Runner,
  '0014-admin-onboarding': migration0014AdminOnboarding,
  '0015-gate-g5': migration0015GateG5,
  '0016-agent-approvals': migration0016AgentApprovals,
  '0017-pushed-head': migration0017PushedHead,
  '0018-plan-files': migration0018PlanFiles,
  '0019-gate-g7': migration0019GateG7,
  '0020-kill-switch': migration0020KillSwitch,
};
