// Response body of the project AI record (snake_case). Fields picked explicitly.
import { consentOf, type ProjectAiRecord } from '@sdlc/core';

export function presentAiRecord(
  record: ProjectAiRecord,
  project: { readonly id: string; readonly slug: string },
): Record<string, unknown> {
  return {
    project: { id: project.id, slug: project.slug },
    version: record.version,
    ai_allowed: record.ai_allowed,
    allowed_data_classes: record.allowed_data_classes,
    prod_logs_allowed: record.prod_logs_allowed,
    disclosure_format: record.disclosure_format,
    confirmed_at: record.confirmed_at,
    consent: consentOf(record.confirmed_at),
    record_ref: record.record_ref,
    record_sha256: record.record_sha256,
    updated_by: record.updated_by,
    created_at: record.created_at.toISOString(),
  };
}
