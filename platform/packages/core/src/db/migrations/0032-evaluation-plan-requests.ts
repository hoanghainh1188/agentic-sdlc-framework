// Migration 0032: a person's request to run an evaluation plan now (design/D-05 section 6.9,
// version 1.49; D-08 L05; design/ADR-M82 §2.4, §2.7; QUESTIONS #476). Rules for every migration:
// see the header of 0001-tenancy.ts and design/ADR-M09. Migration 0031 is merged and never edited.
//
// The api has no access to the gateway's model list or the task sets, so **Run now** records a
// request on the plan; the worker's plan loop starts the evaluation and checks the models and the
// task set (QUESTIONS #476). When it cannot start, it writes the refusal code on the plan for the
// dashboard to show. Codes, IDs and times only.
import { defineMigration } from './define.js';

const CODE = `~ '^[a-z][a-z0-9_.-]{0,63}$'`;

export const migration0032EvaluationPlanRequests = defineMigration({
  up: [
    `ALTER TABLE evaluation_plans
       ADD COLUMN run_requested_at timestamptz,
       ADD COLUMN run_requested_by uuid,
       ADD COLUMN last_refusal text CHECK (last_refusal ${CODE}),
       ADD COLUMN last_refusal_at timestamptz`,
    `ALTER TABLE evaluation_plans
       ADD CONSTRAINT evaluation_plans_run_requested_by_fkey FOREIGN KEY (tenant_id, run_requested_by)
         REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
       ADD CONSTRAINT evaluation_plans_request CHECK (
         (run_requested_at IS NULL) = (run_requested_by IS NULL)),
       ADD CONSTRAINT evaluation_plans_refusal CHECK (
         (last_refusal IS NULL) = (last_refusal_at IS NULL))`,
    // The worker's loop looks for requests across tenants.
    `CREATE INDEX evaluation_plans_requested ON evaluation_plans (run_requested_at)
       WHERE run_requested_at IS NOT NULL`,
    `GRANT UPDATE (run_requested_at, run_requested_by, last_refusal, last_refusal_at)
       ON evaluation_plans TO platform_app`,
  ],
  // Development only (ADR-M09).
  down: [
    `DROP INDEX evaluation_plans_requested`,
    `ALTER TABLE evaluation_plans DROP CONSTRAINT evaluation_plans_refusal,
       DROP CONSTRAINT evaluation_plans_request,
       DROP CONSTRAINT evaluation_plans_run_requested_by_fkey`,
    `ALTER TABLE evaluation_plans DROP COLUMN last_refusal_at, DROP COLUMN last_refusal,
       DROP COLUMN run_requested_by, DROP COLUMN run_requested_at`,
  ],
});
