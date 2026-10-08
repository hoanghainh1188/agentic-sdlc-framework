// Migration 0026: the structure and the acceptance criteria count of a spec (design/D-05 section
// 6.2, version 1.38; D-08 S01; design/ADR-M61; QUESTIONS #290). Rules for every migration: see
// the header of 0001-tenancy.ts and design/ADR-M09.
//
// - Every spec linked from now on carries the rule that found its acceptance criteria
//   (`structure`, a code) and how many it found. Counts and codes only: the spec's text stays in
//   the repository (ADR-M39 §2.3).
// - Rows linked before S01 have neither (null). G2 treats them as no criteria (fail closed,
//   QUESTIONS #290): a person links the spec again.
// - Rows still never change: no UPDATE grant.
import { defineMigration } from './define.js';

export const migration0026SpecStructure = defineMigration({
  up: [
    `ALTER TABLE spec_refs
       ADD COLUMN structure           text,
       ADD COLUMN acceptance_criteria integer,
       ADD CONSTRAINT spec_refs_structure_code CHECK (
         structure IN ('spec_kit', 'bmad_story', 'bmad_epics', 'manual_heading', 'none')),
       ADD CONSTRAINT spec_refs_acceptance_criteria_range CHECK (
         acceptance_criteria BETWEEN 0 AND 10000),
       ADD CONSTRAINT spec_refs_structure_set CHECK (
         (structure IS NULL) = (acceptance_criteria IS NULL)),
       ADD CONSTRAINT spec_refs_structure_none CHECK (
         structure <> 'none' OR acceptance_criteria = 0)`,
  ],
  // Development only (ADR-M09).
  down: [
    `ALTER TABLE spec_refs
       DROP CONSTRAINT spec_refs_structure_none,
       DROP CONSTRAINT spec_refs_structure_set,
       DROP CONSTRAINT spec_refs_acceptance_criteria_range,
       DROP CONSTRAINT spec_refs_structure_code,
       DROP COLUMN acceptance_criteria,
       DROP COLUMN structure`,
  ],
});
