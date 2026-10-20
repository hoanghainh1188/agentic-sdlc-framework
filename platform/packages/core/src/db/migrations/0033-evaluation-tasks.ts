// Migration 0033: a project's own evaluation tasks (design/D-05 section 6.10, version 1.50; D-08
// L07; design/ADR-M85 §2.6–§2.8; QUESTIONS #485–#487). Rules for every migration: see the header
// of 0001-tenancy.ts and design/ADR-M09. Migration 0032 is merged and never edited.
//
// - `evaluation_tasks`: one task of a project, a reference to its card on the default branch
//   (`.sdlc/eval-tasks/<id>.yaml`): the card's path, commit and SHA-256, the intent, the base and
//   merge commits, a status and the code of the last check. Never the card's content, the spec,
//   a test or a diff. The identity (project, task ID, intent, path) never changes; a changed card
//   changes its commit and SHA-256 and goes back to `registered`. `gone` is final (trigger SDA24).
//   Never deleted.
// - `evaluation_task_decisions` is append-only (D-05 D3): one row per review decision, bound to
//   the card's SHA-256; the reviewer's user ID and a reason code, never text.
//
// Errors raised by the triggers (class `SD`, mapped in errors.ts):
//   SDA24  an evaluation task's fixed columns, or a task that is `gone`
import { defineMigration } from './define.js';

const CODE = `~ '^[a-z][a-z0-9_.-]{0,63}$'`;
const TASK_ID = `~ '^[a-z][a-z0-9-]{1,47}$'`;
const COMMIT = `~ '^[0-9a-f]{40}$'`;
const HEX64 = `~ '^[0-9a-f]{64}$'`;

export const migration0033EvaluationTasks = defineMigration({
  up: [
    `CREATE TABLE evaluation_tasks (
       id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id        uuid NOT NULL,
       project_id       uuid NOT NULL,
       task_id          text NOT NULL CHECK (task_id ${TASK_ID}),
       intent_id        uuid NOT NULL,
       card_path        text NOT NULL CHECK (card_path = '.sdlc/eval-tasks/' || task_id || '.yaml'),
       card_commit      char(40) NOT NULL CHECK (card_commit ${COMMIT}),
       card_sha256      char(64) NOT NULL CHECK (card_sha256 ${HEX64}),
       base_commit      char(40) NOT NULL CHECK (base_commit ${COMMIT}),
       merge_commit     char(40) NOT NULL CHECK (merge_commit ${COMMIT}),
       status           text NOT NULL DEFAULT 'registered'
                          CHECK (status IN ('registered', 'checking', 'checked', 'check_failed',
                                            'approved', 'rejected', 'gone')),
       check_code       text CHECK (check_code ${CODE}),
       registered_by    uuid,
       updated_at       timestamptz NOT NULL DEFAULT now(),
       created_at       timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT evaluation_tasks_tenant_id_id_key UNIQUE (tenant_id, id),
       CONSTRAINT evaluation_tasks_task_key UNIQUE (tenant_id, project_id, task_id),
       CONSTRAINT evaluation_tasks_project_fkey FOREIGN KEY (tenant_id, project_id)
         REFERENCES projects (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT evaluation_tasks_intent_fkey FOREIGN KEY (tenant_id, intent_id)
         REFERENCES intents (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT evaluation_tasks_registered_by_fkey FOREIGN KEY (tenant_id, registered_by)
         REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT evaluation_tasks_commits CHECK (base_commit <> merge_commit),
       CONSTRAINT evaluation_tasks_check_code CHECK (
         (status = 'check_failed') = (check_code IS NOT NULL))
     )`,
    `CREATE INDEX evaluation_tasks_tenant_id_project_id_idx
       ON evaluation_tasks (tenant_id, project_id)`,
    // The worker's check loop (PR 4) looks for tasks to check across tenants.
    `CREATE INDEX evaluation_tasks_to_check ON evaluation_tasks (updated_at)
       WHERE status = 'registered'`,
    `CREATE FUNCTION evaluation_tasks_guard() RETURNS trigger
       LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
     BEGIN
       IF (NEW.id, NEW.tenant_id, NEW.project_id, NEW.task_id, NEW.intent_id, NEW.card_path,
           NEW.registered_by, NEW.created_at)
          IS DISTINCT FROM
          (OLD.id, OLD.tenant_id, OLD.project_id, OLD.task_id, OLD.intent_id, OLD.card_path,
           OLD.registered_by, OLD.created_at) THEN
         RAISE EXCEPTION 'evaluation task %: the identity never changes', OLD.id
           USING ERRCODE = 'SDA24';
       END IF;
       IF OLD.status = 'gone' THEN
         RAISE EXCEPTION 'evaluation task %: a gone task is final', OLD.id USING ERRCODE = 'SDA24';
       END IF;
       RETURN NEW;
     END $$`,
    `CREATE TRIGGER evaluation_tasks_guard BEFORE UPDATE ON evaluation_tasks
       FOR EACH ROW EXECUTE FUNCTION evaluation_tasks_guard()`,
    `CREATE TRIGGER evaluation_tasks_no_delete BEFORE DELETE ON evaluation_tasks
       FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`,
    `CREATE TRIGGER evaluation_tasks_no_truncate BEFORE TRUNCATE ON evaluation_tasks
       FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()`,

    `CREATE TABLE evaluation_task_decisions (
       id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
       tenant_id     uuid NOT NULL,
       task_id       uuid NOT NULL,
       card_sha256   char(64) NOT NULL CHECK (card_sha256 ${HEX64}),
       decision      text NOT NULL CHECK (decision IN ('approved', 'rejected')),
       reason        text CHECK (reason ${CODE}),
       decided_by    uuid NOT NULL,
       created_at    timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT evaluation_task_decisions_task_fkey FOREIGN KEY (tenant_id, task_id)
         REFERENCES evaluation_tasks (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT evaluation_task_decisions_decided_by_fkey FOREIGN KEY (tenant_id, decided_by)
         REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT evaluation_task_decisions_reason CHECK (
         (decision = 'rejected') = (reason IS NOT NULL))
     )`,
    `CREATE INDEX evaluation_task_decisions_task_idx
       ON evaluation_task_decisions (tenant_id, task_id)`,
    `CREATE TRIGGER evaluation_task_decisions_no_update_delete
       BEFORE UPDATE OR DELETE ON evaluation_task_decisions
       FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`,
    `CREATE TRIGGER evaluation_task_decisions_no_truncate
       BEFORE TRUNCATE ON evaluation_task_decisions
       FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()`,

    `REVOKE ALL ON evaluation_tasks, evaluation_task_decisions FROM PUBLIC`,
    `GRANT SELECT, INSERT ON evaluation_tasks, evaluation_task_decisions TO platform_app`,
    `GRANT UPDATE (card_commit, card_sha256, base_commit, merge_commit, status, check_code,
                   updated_at) ON evaluation_tasks TO platform_app`,
  ],
  // Development only (ADR-M09).
  down: [
    `DROP TABLE IF EXISTS evaluation_task_decisions`,
    `DROP TABLE IF EXISTS evaluation_tasks`,
    `DROP FUNCTION IF EXISTS evaluation_tasks_guard()`,
  ],
});
