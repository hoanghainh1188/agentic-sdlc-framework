// The operator's retention report (task E05, design/ADR-M51): `pnpm sdlc ops retention report`.
// Counts only, from the database (no evidence store access): per project, how many rows are
// stored, purged, held, open, waiting for their retention, and due now. The worker's loop decides
// for itself; this report reads the same rules with the same clock.
import type { TenantScope } from '../db/tenant-scope.js';
import { loadEffectiveConfig } from '../registry/effective-config.js';
import { archiveTimes } from './pass.js';
import { archivePurgeDue, retentionCutoff } from './rules.js';

export interface RetentionProjectReport {
  readonly projectId: string;
  readonly projectSlug: string;
  readonly status: string;
  /** Null when the project's configuration cannot be loaded (no retention purge: fail closed). */
  readonly retentionDays: number | null;
  readonly archivePurgeDue: boolean;
  readonly purged: number;
  readonly held: number;
  readonly open: number;
  /** Finished, not held, not purged. */
  readonly stored: number;
  /** Of `stored`: due for the purge now (at most `limit`). */
  readonly due: number;
}

export async function retentionReport(
  scope: TenantScope,
  options: { readonly now: Date; readonly archiveGraceDays: number; readonly limit: number },
): Promise<RetentionProjectReport[]> {
  const report: RetentionProjectReport[] = [];
  for (const project of await scope.retention.listProjects()) {
    let retentionDays: number | null;
    try {
      const { config } = await loadEffectiveConfig(scope.projectConfigs, project.id);
      retentionDays = config.retention.evidence_retention_days;
    } catch {
      // As the loop: no retention purge for a configuration that cannot be loaded.
      retentionDays = null;
    }
    let archiveDue = false;
    if (project.status === 'archived') {
      // As the loop: from the later of the archive and the scheduled purge; not scheduled yet:
      // not due (the loop schedules it on its first `purge` pass).
      const { archivedAt, scheduledAt } = await archiveTimes(scope, project.id);
      archiveDue =
        archivedAt !== null &&
        scheduledAt !== null &&
        archivePurgeDue(
          options.now,
          archivedAt > scheduledAt ? archivedAt : scheduledAt,
          options.archiveGraceDays,
        );
    }
    const tally = await scope.retention.projectCounts(project.id);
    const due =
      archiveDue || retentionDays !== null
        ? (
            await scope.retention.purgeCandidates({
              projectId: project.id,
              cutoff: archiveDue ? options.now : retentionCutoff(options.now, retentionDays!),
              limit: options.limit,
            })
          ).length
        : 0;
    report.push({
      projectId: project.id,
      projectSlug: project.slug,
      status: project.status,
      retentionDays,
      archivePurgeDue: archiveDue,
      purged: tally.purged,
      held: tally.held,
      open: tally.open,
      stored: tally.remaining,
      due,
    });
  }
  return report;
}
