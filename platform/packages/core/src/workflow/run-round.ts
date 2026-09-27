// The runs of an intent's current `running` round (task C06 session 2, ADR-M33 §2.6).
import { FINAL_RUN_STATUSES, type RunStatus } from '@sdlc/contracts';

import type { Intent, Run } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';

export function isFinalRun(status: RunStatus): boolean {
  return (FINAL_RUN_STATUSES as readonly string[]).includes(status);
}

/**
 * The runs started since the intent last became `running` (its `updated_at` is the move; both
 * times come from the database clock). Older runs belong to earlier rounds and are never finished
 * again.
 */
export async function roundRuns(tx: TenantScope, intent: Intent): Promise<Run[]> {
  if (intent.status !== 'running') return [];
  const since = new Date(intent.updated_at).getTime();
  return (await tx.runs.listForIntent(intent.id)).filter(
    (r) => new Date(r.created_at).getTime() >= since,
  );
}
