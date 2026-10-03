// Migration 0017: the pushed head of a run (design/D-05 section 6.4, version 1.22; D-08 C08 AC1;
// design/ADR-M38 §2.2; ADR-M29 §2.5). Rules for every migration: see the header of
// 0001-tenancy.ts and design/ADR-M09.
//
// `runs.head_sha` is "the last commit pushed" (D-05). Until C08 the runner wrote there the HEAD
// the sandbox reported, which the agent controls. From C08 the runner keeps that value in the run
// event `agent_finished` only, and writes `head_sha` once, after it pushed the commit it made
// itself from the checked diff. A run is final before G5, so the trigger that keeps final runs
// unchanged gets one exception: on a `succeeded` run, `head_sha` may go from null to a value, with
// nothing else changed but `updated_at`. Every other change of a final run is still refused
// (SDA05).
import { defineMigration } from './define.js';

const FINAL = `'succeeded', 'succeeded_proposal_only', 'failed', 'stopped_budget', 'stopped_scope',
  'stopped_timeout', 'stopped_stalled', 'stopped_killed', 'cancelled'`;

export const migration0017PushedHead = defineMigration({
  up: [
    `CREATE OR REPLACE FUNCTION runs_final_status_is_final() RETURNS trigger
       LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
     BEGIN
       IF OLD.status IN (${FINAL}) THEN
         IF OLD.status = 'succeeded'
            AND OLD.head_sha IS NULL
            AND NEW.head_sha IS NOT NULL
            AND (NEW.status, NEW.stop_reason, NEW.started_at, NEW.finished_at, NEW.iterations,
                 NEW.killed_by)
                IS NOT DISTINCT FROM
                (OLD.status, OLD.stop_reason, OLD.started_at, OLD.finished_at, OLD.iterations,
                 OLD.killed_by) THEN
           RETURN NEW;
         END IF;
         RAISE EXCEPTION 'run %: status % is final', OLD.id, OLD.status USING ERRCODE = 'SDA05';
       END IF;
       RETURN NEW;
     END $$`,
  ],
  // Development only (ADR-M09): back to the function of migration 0004.
  down: [
    `CREATE OR REPLACE FUNCTION runs_final_status_is_final() RETURNS trigger
       LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
     BEGIN
       IF OLD.status IN (${FINAL}) THEN
         RAISE EXCEPTION 'run %: status % is final', OLD.id, OLD.status USING ERRCODE = 'SDA05';
       END IF;
       RETURN NEW;
     END $$`,
  ],
});
