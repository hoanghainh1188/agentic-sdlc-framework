// The fingerprint of an agent version (task L09, design/ADR-M86 §2.1): its model, the SHA-256 of
// its instructions, the SHA-256 of its sorted tools and its adapter (X03, QUESTIONS #526). An evaluation counts as evidence for a
// version only when one of its configurations has the same fingerprint. The fingerprint is
// compared in the database and in memory, never written to the audit log (ADR-M86 §2.7).
import { createHash } from 'node:crypto';

/** SHA-256 of the sorted tool names as canonical JSON (for example `["file_editor","terminal"]`). */
export function toolsSha256(tools: readonly string[]): string {
  const sorted = [...tools].sort();
  return createHash('sha256').update(JSON.stringify(sorted), 'utf8').digest('hex');
}
