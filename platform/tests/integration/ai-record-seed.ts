// Creates a project AI record for the tests that step intents: since task B12, the submit
// (Draft → G1) waits for a record that allows the intent's data class (D-02 FR-19, ADR-M32).
import type { DataClass } from '../../packages/contracts/src/codes.js';
import type { ProjectAiRecord } from '../../packages/core/src/db/schema.js';
import type { TenantScope } from '../../packages/core/src/db/tenant-scope.js';

export interface SeedAiRecordOptions {
  /** Default: every class a client may allow without a written answer (Ch.2 Rule 3). */
  readonly allowedDataClasses?: readonly DataClass[];
  /** `YYYY-MM-DD`; default: consent unknown. */
  readonly confirmedAt?: string | null;
}

/** Version 1 of the project's AI record, written by `updatedBy` (no role check: a seed). */
export function seedAiRecord(
  scope: TenantScope,
  projectId: string,
  updatedBy: string,
  options: SeedAiRecordOptions = {},
): Promise<ProjectAiRecord> {
  const confirmedAt = options.confirmedAt ?? null;
  return scope.projectAiRecords.save(projectId, {
    aiAllowed: 'yes',
    allowedDataClasses: options.allowedDataClasses ?? ['public', 'internal', 'client_restricted'],
    prodLogsAllowed: 'no',
    disclosureFormat: 'standard_note',
    confirmedAt,
    recordRef: confirmedAt === null ? null : 'https://docs.example.test/project/ai-record',
    updatedBy,
    actorType: 'human',
    expectedVersion: 0,
  });
}
