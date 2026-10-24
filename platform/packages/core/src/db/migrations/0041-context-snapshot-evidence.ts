// Migration 0041: the evidence kind `context_snapshot` (design/D-05 section 6.6, version 1.60; D-08
// X07; design/ADR-M90 §2.2; QUESTIONS #556). Rules for every migration: see the header of
// 0001-tenancy.ts and design/ADR-M09. Migrations 0001–0040 are merged and never edited.
//
// - `context_snapshot`: what the agent of one run read, as one canonical JSON file: the run's base
//   commit, the plan and spec versions, the SHA-256 of each repository path it opened, counts, and
//   the `knowledge_read` hashes of its tools. Hashes and counts only, never a path or a text. The
//   run event `context_snapshot` holds its SHA-256 and the counts.
import { defineMigration } from './define.js';

const KINDS = `('spec', 'plan', 'proposal', 'diff', 'ci_result', 'test_report', 'scan_report',
  'review', 'cost_summary', 'disclosure_note', 'knowledge_read', 'context_snapshot')`;

const OLD_KINDS = `('spec', 'plan', 'proposal', 'diff', 'ci_result', 'test_report', 'scan_report',
  'review', 'cost_summary', 'disclosure_note', 'knowledge_read')`;

export const migration0041ContextSnapshotEvidence = defineMigration({
  up: [
    `ALTER TABLE evidence_items DROP CONSTRAINT evidence_items_kind_check`,
    `ALTER TABLE evidence_items ADD CONSTRAINT evidence_items_kind_check CHECK (kind IN ${KINDS})`,
  ],
  down: [
    `ALTER TABLE evidence_items DROP CONSTRAINT evidence_items_kind_check`,
    `ALTER TABLE evidence_items ADD CONSTRAINT evidence_items_kind_check CHECK (kind IN ${OLD_KINDS})`,
  ],
});
