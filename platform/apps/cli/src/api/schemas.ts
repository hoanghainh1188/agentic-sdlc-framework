// Response schemas of the API (ADR-M26 §2.8, ADR-M28 §2.7, ADR-M32 §2.4). API output is external
// data: the CLI keeps only the fields below and refuses a body that does not match. The test
// platform/tests/cli/api-schemas.test.ts checks them against the API's own presenters.
import { z } from 'zod';

const id = z.string().max(64);
const code = z.string().max(64);
const time = z.string().max(40);
const ref = z.string().max(512);
const codes = z.record(z.string(), z.unknown());

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: code,
    message: z.string().max(2000),
    reason: code.optional(),
    reason_message: z.string().max(2000).optional(),
    details: z
      .array(z.object({ path: z.string().max(200), issue: z.string().max(200) }))
      .max(100)
      .optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

export const meSchema = z.object({
  user: z.object({ id, display_name: z.string().max(200), email: z.string().max(320) }),
  tenant_id: id,
  token_id: id,
  roles: z
    .array(z.object({ project: z.object({ id, slug: code.nullable() }), role: code }))
    .max(10_000),
});
export type Me = z.infer<typeof meSchema>;

export const intentSchema = z.object({
  id,
  code,
  project: z.object({ id, slug: code }),
  title: z.string().max(1000),
  description: z.string().max(20_000),
  risk_tier: code,
  data_class: code,
  max_autonomy: code,
  budget_usd: code,
  status: code,
  current_gate: code.nullable(),
  issue_number: z.number().int().nullable(),
  pr_number: z.number().int().nullable(),
  created_by: id,
  created_at: time,
  updated_at: time,
});
export type IntentView = z.infer<typeof intentSchema>;

export const decisionSchema = z.object({
  id,
  gate: code,
  decision: code,
  oversight_mode: code,
  approver_role: code.nullable(),
  actor_type: code,
  decided_by: id.nullable(),
  reason_code: code.nullable(),
  reason_ref: ref.nullable(),
  input_sha256: code,
  scope: codes.nullable(),
  expires_at: time.nullable(),
  config_hash: code,
  source: code,
  voids_decision_id: id.nullable(),
  created_at: time,
});
export type DecisionView = z.infer<typeof decisionSchema>;

export const intentDetailSchema = intentSchema.extend({
  spec: z
    .object({ version: z.number().int(), path: ref, commit_sha: code, content_sha256: code })
    .nullable(),
  plan: z
    .object({
      version: z.number().int(),
      plan_sha256: code,
      change_flags: z.array(code).max(50),
    })
    .nullable(),
  decisions: z.array(decisionSchema).max(10_000),
});
export type IntentDetail = z.infer<typeof intentDetailSchema>;

export const intentPageSchema = z.object({
  items: z.array(intentSchema).max(1000),
  next_cursor: z.string().max(200).nullable(),
});

export const escalationSchema = z.object({
  id,
  code,
  intent: z.object({ id, code }),
  run_id: id.nullable(),
  trigger: code,
  route: code,
  severity: code,
  response_level: code,
  status: code,
  freezes_intent: z.boolean(),
  current_step: code,
  owner_id: id.nullable(),
  backup_owner_id: id.nullable(),
  packet: codes,
  ack_due_at: time.nullable(),
  step_due_at: time.nullable(),
  resolve_due_at: time.nullable(),
  acknowledged_by: id.nullable(),
  acknowledged_at: time.nullable(),
  decision: codes.nullable(),
  decided_by: id.nullable(),
  decided_at: time.nullable(),
  closed_at: time.nullable(),
  created_at: time,
});
export type EscalationView = z.infer<typeof escalationSchema>;

export const escalationListSchema = z.object({ items: z.array(escalationSchema).max(1000) });

export const aiRecordSchema = z.object({
  project: z.object({ id, slug: code }),
  version: z.number().int(),
  ai_allowed: code,
  allowed_data_classes: z.array(code).max(20),
  prod_logs_allowed: code,
  disclosure_format: code,
  confirmed_at: z.string().max(10).nullable(),
  consent: code,
  record_ref: ref.nullable(),
  record_sha256: code,
  updated_by: id,
  created_at: time,
});
export type AiRecordView = z.infer<typeof aiRecordSchema>;
