// Migration 0016: approvals of the agent register (design/D-05 section 6.1, version 1.21; D-08 B13
// AC7; handbook Ch.20 §20.7, §20.9, §20.11; design/ADR-M37 §2.8; QUESTIONS #153). Rules for every
// migration: see the header of 0001-tenancy.ts and design/ADR-M09.
//
// - One row per person who approved an agent's activation or retirement. Codes and IDs only.
// - An approval is bound to the agent as it was when it was given: its version and its
//   `updated_at` (`round_at`). Any later change of the agent (status, configuration, owner) starts
//   a new round, and older approvals no longer count.
// - One approval per person, purpose and round: the approvers of a set are always different people.
// - Append-only (D-05 D3): SELECT and INSERT only for `platform_app`; triggers refuse UPDATE,
//   DELETE and TRUNCATE.
import { defineMigration } from './define.js';

export const migration0016AgentApprovals = defineMigration({
  up: [
    `CREATE TABLE agent_approvals (
       id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id     uuid NOT NULL,
       agent_id      uuid NOT NULL,
       agent_version text NOT NULL CHECK (agent_version ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$'),
       purpose       text NOT NULL CHECK (purpose IN ('activate', 'retire')),
       capacity      text NOT NULL CHECK (capacity IN ('owner', 'person_a', 'person_b', 'governance')),
       approver_id   uuid NOT NULL,
       round_at      timestamptz NOT NULL,
       created_at    timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT agent_approvals_agent_fkey FOREIGN KEY (tenant_id, agent_id)
         REFERENCES agents (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT agent_approvals_approver_fkey FOREIGN KEY (tenant_id, approver_id)
         REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT agent_approvals_one_per_person
         UNIQUE (tenant_id, agent_id, purpose, round_at, approver_id),
       CONSTRAINT agent_approvals_one_per_capacity
         UNIQUE (tenant_id, agent_id, purpose, round_at, capacity)
     )`,
    `CREATE TRIGGER agent_approvals_no_update_delete BEFORE UPDATE OR DELETE ON agent_approvals
       FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`,
    `CREATE TRIGGER agent_approvals_no_truncate BEFORE TRUNCATE ON agent_approvals
       FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()`,
    `REVOKE ALL ON agent_approvals FROM PUBLIC`,
    `GRANT SELECT, INSERT ON agent_approvals TO platform_app`,
  ],
  // Development only (ADR-M09).
  down: [`DROP TABLE agent_approvals`],
});
