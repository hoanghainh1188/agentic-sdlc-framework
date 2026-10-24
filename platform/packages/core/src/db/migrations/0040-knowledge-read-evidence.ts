// Migration 0040: the evidence kind `knowledge_read` and the tools' cost label (design/D-05 section 6.6, version 1.59; D-08
// X04 PR 3b; design/ADR-M89 §2.5; QUESTIONS #536, #544). Rules for every migration: see the header
// of 0001-tenancy.ts and design/ADR-M09. Migrations 0001–0039 are merged and never edited.
//
// - `knowledge_read`: the sorted list of document ID and content hash a run's `read_documents`
//   tool returned (IDs and hashes only, never a path, a query or a text). The run event
//   `knowledge_read` holds its SHA-256 and the counts.
// - `cost_records.agent` also takes a register tool's code, `tool:<tool_key>`: the label `agent`
//   of a tool's own model key (ADR-M69 §2.4, QUESTIONS #542). Agent keys never hold a colon.
import { defineMigration } from './define.js';

const KINDS = `('spec', 'plan', 'proposal', 'diff', 'ci_result', 'test_report', 'scan_report',
  'review', 'cost_summary', 'disclosure_note', 'knowledge_read')`;

const OLD_KINDS = `('spec', 'plan', 'proposal', 'diff', 'ci_result', 'test_report', 'scan_report',
  'review', 'cost_summary', 'disclosure_note')`;

export const migration0040KnowledgeReadEvidence = defineMigration({
  up: [
    `ALTER TABLE evidence_items DROP CONSTRAINT evidence_items_kind_check`,
    `ALTER TABLE evidence_items ADD CONSTRAINT evidence_items_kind_check CHECK (kind IN ${KINDS})`,
    `ALTER TABLE cost_records DROP CONSTRAINT cost_records_agent_check`,
    `ALTER TABLE cost_records ADD CONSTRAINT cost_records_agent_check
       CHECK (agent ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$')`,
  ],
  down: [
    `ALTER TABLE cost_records DROP CONSTRAINT cost_records_agent_check`,
    `ALTER TABLE cost_records ADD CONSTRAINT cost_records_agent_check
       CHECK (agent ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')`,
    `ALTER TABLE evidence_items DROP CONSTRAINT evidence_items_kind_check`,
    `ALTER TABLE evidence_items ADD CONSTRAINT evidence_items_kind_check CHECK (kind IN ${OLD_KINDS})`,
  ],
});
