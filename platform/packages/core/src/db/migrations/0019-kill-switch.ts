// Migration 0019: the kill switch (design/D-05 section 6.4, version 1.26; D-08 C11 AC2; D-02
// FR-34; design/ADR-M42; QUESTIONS #180–#183). Rules for every migration: see the header of
// 0001-tenancy.ts and design/ADR-M09.
//
// A kill moves a run that a runner holds (`provisioning`, `running`) to `stopping`, with the
// person in `killed_by` (null when an operator kills it: actor `system`). A `queued` run goes
// straight to `stopped_killed`. The runner (or the worker, when the runner is lost) then ends the
// run `stopped_killed` / `killed`. So:
// - `killed_by` is allowed on `stopping` too (it was `stopped_killed` only, migration 0004);
// - a `stopped_killed` run has the stop reason `killed`;
// - a `stopping` run only ever ends `stopped_killed`, and `killed_by`, once set, never changes
//   (trigger, `SDA13`), so no later writer can turn a kill into another outcome.
import { defineMigration } from './define.js';

export const migration0019KillSwitch = defineMigration({
  up: [
    `ALTER TABLE runs
       DROP CONSTRAINT runs_killed_status,
       ADD CONSTRAINT runs_killed_status
         CHECK (killed_by IS NULL OR status IN ('stopping', 'stopped_killed')),
       ADD CONSTRAINT runs_killed_reason
         CHECK (status <> 'stopped_killed' OR stop_reason = 'killed')`,
    `CREATE FUNCTION runs_stopping_ends_killed() RETURNS trigger
       LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
     BEGIN
       IF OLD.status = 'stopping' AND NEW.status NOT IN ('stopping', 'stopped_killed') THEN
         RAISE EXCEPTION 'run %: a stopping run ends stopped_killed, not %', OLD.id, NEW.status
           USING ERRCODE = 'SDA13';
       END IF;
       IF OLD.killed_by IS NOT NULL AND NEW.killed_by IS DISTINCT FROM OLD.killed_by THEN
         RAISE EXCEPTION 'run %: killed_by is set once', OLD.id USING ERRCODE = 'SDA13';
       END IF;
       RETURN NEW;
     END $$`,
    `CREATE TRIGGER runs_stopping_ends_killed BEFORE UPDATE ON runs
       FOR EACH ROW EXECUTE FUNCTION runs_stopping_ends_killed()`,
  ],
  // Development only (ADR-M09).
  down: [
    `DROP TRIGGER runs_stopping_ends_killed ON runs`,
    `DROP FUNCTION runs_stopping_ends_killed()`,
    `ALTER TABLE runs
       DROP CONSTRAINT runs_killed_reason,
       DROP CONSTRAINT runs_killed_status,
       ADD CONSTRAINT runs_killed_status CHECK (killed_by IS NULL OR status = 'stopped_killed')`,
  ],
});
