// Migration 0005: cost records (design/D-05 sections 6.5 and 9; D-02 FR-51, FR-53; D-08 C03;
// design/ADR-M24).
// Rules for every migration: see the header of 0001-tenancy.ts and design/ADR-M09.
//
// - `cost_records` is append-only (D-05 D3) and never deleted in the MVP (D-05 section 10), so
//   every column holds a code, an ID or a number, never free text (CLAUDE.md). The CHECKs below
//   are the backstop; the Cost Controller maps gateway rows to these formats first.
// - One row per model call. `source_ref` is the gateway's request ID; unique per tenant, so a
//   sync that reads the same call twice inserts it once (D-08 C03 AC4).
import { defineMigration } from './define.js';

// Model names as the gateway knows them, for example `anthropic/claude-haiku-4-5-20251001`.
const MODEL = `~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$'`;
// Agent keys from the agent register, for example `coder-openhands`.
const AGENT = `~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'`;
// Gateway request IDs: UUIDs or provider IDs such as `chatcmpl-…` and `msg_…`.
const SOURCE_REF = `~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'`;

export const migration0005CostRecords = defineMigration({
  up: [
    `CREATE TABLE cost_records (
       id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
       tenant_id           uuid NOT NULL,
       project_id          uuid NOT NULL,
       intent_id           uuid,
       run_id              uuid,
       gate                gate_code,
       agent               text CHECK (agent ${AGENT}),
       model               text NOT NULL CHECK (model ${MODEL}),
       provider_type       text NOT NULL CHECK (provider_type IN ('api', 'self_hosted')),
       input_tokens        bigint NOT NULL CHECK (input_tokens >= 0),
       output_tokens       bigint NOT NULL CHECK (output_tokens >= 0),
       cached_input_tokens bigint NOT NULL DEFAULT 0 CHECK (cached_input_tokens >= 0),
       cost_usd            numeric(18,6) NOT NULL CHECK (cost_usd >= 0),
       source_ref          text NOT NULL CHECK (source_ref ${SOURCE_REF}),
       occurred_at         timestamptz NOT NULL,
       created_at          timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT cost_records_tenant_id_source_ref_key UNIQUE (tenant_id, source_ref),
       CONSTRAINT cost_records_project_fkey FOREIGN KEY (tenant_id, project_id)
         REFERENCES projects (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT cost_records_intent_fkey FOREIGN KEY (tenant_id, intent_id)
         REFERENCES intents (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT cost_records_run_fkey FOREIGN KEY (tenant_id, run_id)
         REFERENCES runs (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT cost_records_run_needs_intent CHECK (run_id IS NULL OR intent_id IS NOT NULL),
       CONSTRAINT cost_records_cached_within_input CHECK (cached_input_tokens <= input_tokens)
     )`,
    `CREATE INDEX cost_records_tenant_id_project_id_occurred_at_idx
       ON cost_records (tenant_id, project_id, occurred_at)`,
    `CREATE INDEX cost_records_tenant_id_intent_id_idx ON cost_records (tenant_id, intent_id)`,
    // Tenant month totals (the tenant budget, ADR-M24 §2.3).
    `CREATE INDEX cost_records_tenant_id_occurred_at_idx ON cost_records (tenant_id, occurred_at)`,

    `CREATE TRIGGER cost_records_no_update_delete BEFORE UPDATE OR DELETE ON cost_records
       FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`,
    `CREATE TRIGGER cost_records_no_truncate BEFORE TRUNCATE ON cost_records
       FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()`,

    `REVOKE ALL ON cost_records FROM PUBLIC`,
    `GRANT SELECT, INSERT ON cost_records TO platform_app`,
  ],
  down: [`DROP TABLE cost_records`],
});
