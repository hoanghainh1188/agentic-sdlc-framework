// Migration 0045: web decision source (task U07; design/ADR-M73 §2.6; QUESTIONS #378).
// Rules for every migration: see the header of 0001-tenancy.ts and design/ADR-M09.
// Migrations 0001–0044 are merged and never edited.
//
// - Allows 'web' in gate_decisions.source
import { defineMigration } from './define.js';

export const migration0045WebDecisionSource = defineMigration({
  up: [
    `ALTER TABLE gate_decisions DROP CONSTRAINT gate_decisions_source_check`,
    `ALTER TABLE gate_decisions ADD CONSTRAINT gate_decisions_source_check
       CHECK (source IN ('cli', 'github_comment', 'github_review', 'workflow', 'web'))`,
  ],
  // Development only (ADR-M09).
  down: [
    `ALTER TABLE gate_decisions DROP CONSTRAINT gate_decisions_source_check`,
    `ALTER TABLE gate_decisions ADD CONSTRAINT gate_decisions_source_check
       CHECK (source IN ('cli', 'github_comment', 'github_review', 'workflow'))`,
  ],
});
