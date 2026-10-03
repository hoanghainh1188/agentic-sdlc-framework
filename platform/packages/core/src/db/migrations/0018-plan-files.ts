// Migration 0018: plans read from the repository (design/D-05 section 6.2, version 1.24; D-08 B09;
// design/ADR-M40; QUESTIONS #165–#169). Rules for every migration: see the header of
// 0001-tenancy.ts and design/ADR-M09.
//
// A plan is the file `.sdlc/plans/<intent code>.yaml` on the default branch. A person submits it;
// the platform reads it there and stores coded fields only:
// - `commit_sha`: the commit the file was read at;
// - `allowed_tools`: the agent tools the plan's tasks list (template T13; QUESTIONS #34, #108);
// - `submitted_by`: the person who submitted it, a producer of the plan at G3 (FR-11).
// Plans stored before B09 (tests) keep the three columns null: they have no file, and G4 uses the
// agent's registered tools for them. A plan read from a file has all three, and no summary (the
// text stays in the repository; QUESTIONS #169).
import { defineMigration } from './define.js';

export const migration0018PlanFiles = defineMigration({
  up: [
    `ALTER TABLE plans
       ADD COLUMN commit_sha char(40) CHECK (commit_sha ~ '^[0-9a-f]{40}$'),
       ADD COLUMN allowed_tools text[]
         CHECK (allowed_tools IS NULL OR (
           cardinality(allowed_tools) BETWEEN 1 AND 3
           AND allowed_tools <@ ARRAY['file_editor', 'task_tracker', 'terminal']::text[])),
       ADD COLUMN submitted_by uuid,
       ADD CONSTRAINT plans_submitted_by_fkey FOREIGN KEY (tenant_id, submitted_by)
         REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
       ADD CONSTRAINT plans_file_columns_check CHECK (
         (commit_sha IS NULL AND allowed_tools IS NULL AND submitted_by IS NULL)
         OR (commit_sha IS NOT NULL AND allowed_tools IS NOT NULL AND submitted_by IS NOT NULL
             AND proposed_by_type = 'human' AND summary = ''))`,
  ],
  // Development only (ADR-M09).
  down: [
    `ALTER TABLE plans
       DROP CONSTRAINT plans_file_columns_check,
       DROP CONSTRAINT plans_submitted_by_fkey,
       DROP COLUMN submitted_by,
       DROP COLUMN allowed_tools,
       DROP COLUMN commit_sha`,
  ],
});
