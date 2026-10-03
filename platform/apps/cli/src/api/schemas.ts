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
      .array(
        z.object({
          path: z.string().max(200),
          issue: z.string().max(200),
          message: z.string().max(2000).optional(),
        }),
      )
      .max(100)
      .optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

export const meSchema = z.object({
  user: z.object({ id, display_name: z.string().max(200), email: z.string().max(320) }),
  tenant_id: id,
  token_id: id,
  tenant_admin: z.boolean().optional(),
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

// Admin endpoints (task B13, ADR-M37 §2.6).
export const adminProjectSchema = z.object({
  id,
  slug: code,
  name: z.string().max(200),
  git_provider: code,
  repo_full_name: z.string().max(200),
  default_branch: z.string().max(100),
  status: code,
  created_at: time,
});
export type AdminProjectView = z.infer<typeof adminProjectSchema>;
export const adminProjectListSchema = z.object({ items: z.array(adminProjectSchema).max(10_000) });

export const adminUserSchema = z.object({
  id,
  display_name: z.string().max(200),
  email: z.string().max(320),
  status: code,
  tenant_admin: z.boolean(),
  created_at: time,
});
export type AdminUserView = z.infer<typeof adminUserSchema>;
export const adminUserListSchema = z.object({ items: z.array(adminUserSchema).max(100_000) });

export const adminIdentitySchema = z.object({
  id,
  user_id: id,
  provider: code,
  external_id: code,
  external_login: code,
  unlinked_at: time.nullable(),
  created_at: time,
});
export type AdminIdentityView = z.infer<typeof adminIdentitySchema>;
export const adminIdentityListSchema = z.object({ items: z.array(adminIdentitySchema).max(1000) });

export const adminRoleSchema = z.object({
  id,
  user_id: id,
  project: z.object({ id, slug: code }),
  role: code,
  revoked_at: time.nullable(),
  created_at: time,
});
export type AdminRoleView = z.infer<typeof adminRoleSchema>;
export const adminRoleListSchema = z.object({ items: z.array(adminRoleSchema).max(100_000) });

export const adminTenantRoleSchema = z.object({
  id,
  user_id: id,
  role: code,
  revoked_at: time.nullable(),
  created_at: time,
});
export type AdminTenantRoleView = z.infer<typeof adminTenantRoleSchema>;
export const adminTenantRoleListSchema = z.object({
  items: z.array(adminTenantRoleSchema).max(10_000),
});

const configIssueSchema = z.object({
  key: z.string().max(200),
  path: z.string().max(200),
  message: z.string().max(2000),
});

export const adminConfigSchema = z.object({
  project: z.object({ id, slug: code }),
  version: z.number().int().min(0),
  config_yaml: z.string().max(64 * 1024),
  config_hash: z.string().max(64),
  override_sha256: z.string().max(64).nullable(),
  updated_by: id.nullable(),
  updated_at: time.nullable(),
  warnings: z.array(configIssueSchema).max(1000),
});
export type AdminConfigView = z.infer<typeof adminConfigSchema>;

// Personal API tokens and the audit check (task B13 PR 2, ADR-M37 §2.8). A token record never
// holds the token; only the answer to an issue does, once.
export const tokenSchema = z.object({
  id,
  user_id: id,
  name: code,
  expires_at: time,
  revoked_at: time.nullable(),
  last_used_at: time.nullable(),
  created_at: time,
});
export type TokenView = z.infer<typeof tokenSchema>;
export const tokenListSchema = z.object({ items: z.array(tokenSchema).max(10_000) });

export const issuedTokenSchema = tokenSchema.extend({
  token: z.string().regex(/^sdlc_pat_[A-Za-z0-9_-]{43}$/),
  for_other_user: z.boolean(),
});
export type IssuedTokenView = z.infer<typeof issuedTokenSchema>;

export const chainSchema = z.object({
  tenant_id: id,
  ok: z.boolean(),
  checked: z.number().int().min(0),
  last_seq: z.number().int().min(0),
  broken: z
    .object({
      seq: z.number().int(),
      reason: z.enum(['seq_gap', 'prev_hash_mismatch', 'hash_mismatch', 'unknown_hash_version']),
    })
    .nullable(),
});
