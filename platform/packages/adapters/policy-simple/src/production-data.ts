// Production logs and data for operations tasks (D-08 B12 AC3, handbook Ch.2 §2.5, template T7).
// The answer comes from the project AI record, never from configuration: the client decides it,
// and it is asked separately from AI use in general. No operations task exists in the MVP yet.
import type { ProductionDataAccess, ProjectAiFacts } from '@sdlc/contracts';

/**
 * `masked` only when the client allowed AI use, confirmed it in writing, and allowed AI on masked
 * production data. Everything else, including a missing record, is `none`.
 */
export function productionDataAccess(input: {
  aiRecord: ProjectAiFacts | null;
}): ProductionDataAccess {
  const record = input.aiRecord;
  if (record === null) return 'none';
  if (record.aiAllowed === 'no' || record.consent !== 'confirmed') return 'none';
  return record.prodLogsAllowed === 'yes_masked' ? 'masked' : 'none';
}
