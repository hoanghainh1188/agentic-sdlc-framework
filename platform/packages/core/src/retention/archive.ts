// The archive clock of the retention loop (task E05, design/ADR-M51 §2.6), shared by the evidence
// purge (`pass.ts`) and the Langfuse purge (`langfuse-pass.ts`, E08, ADR-M53).
import type { TenantScope } from '../db/tenant-scope.js';
import type { RetentionCounts, RetentionPassDeps } from './pass.js';
import { archivePurgeDue } from './rules.js';

/**
 * Whether an archived project's evidence may be purged. The grace period runs from the later of
 * the archive (`project.archived`) and the time the loop, in `purge` mode, first scheduled the
 * purge (`project.purge_scheduled`, written once per archive). So a project archived before the
 * purge was turned on (or before E05) still gets the full grace period from the first `purge`
 * pass, with an audit event and a log line an operator can see (review of E05 PR 1).
 */
export async function archiveDueFor(
  deps: RetentionPassDeps,
  scope: TenantScope,
  projectId: string,
  now: Date,
  counts: RetentionCounts,
): Promise<boolean> {
  const { archivedAt, scheduledAt } = await archiveTimes(scope, projectId);
  if (archivedAt === null) return false;
  if (scheduledAt === null) {
    if (deps.settings.mode !== 'purge') return false;
    await scope.audit.append({
      action: 'project.purge_scheduled',
      actorType: 'system',
      actorId: null,
      entityId: projectId,
      payload: { grace_days: deps.settings.archiveGraceDays },
      occurredAt: now,
    });
    counts.archivesScheduled += 1;
    deps.logger.log('warn', 'retention.archive_purge_scheduled', {
      tenant_id: scope.tenantId,
      project_id: projectId,
      grace_days: deps.settings.archiveGraceDays,
    });
    return false;
  }
  const start = archivedAt > scheduledAt ? archivedAt : scheduledAt;
  return archivePurgeDue(now, start, deps.settings.archiveGraceDays);
}

/** The latest archive of a project and the purge scheduled after it (null when none). */
export async function archiveTimes(
  scope: TenantScope,
  projectId: string,
): Promise<{ archivedAt: Date | null; scheduledAt: Date | null }> {
  const events = await scope.audit.listForEntity(projectId, [
    'project.archived',
    'project.purge_scheduled',
  ]);
  const archived = events.filter((e) => e.action === 'project.archived').at(-1);
  if (!archived) return { archivedAt: null, scheduledAt: null };
  const scheduled = events
    .filter((e) => e.action === 'project.purge_scheduled' && Number(e.seq) > Number(archived.seq))
    .at(-1);
  return {
    archivedAt: new Date(archived.occurred_at),
    scheduledAt: scheduled ? new Date(scheduled.occurred_at) : null,
  };
}
