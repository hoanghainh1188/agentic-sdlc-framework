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

const specRefSchema = z.object({
  version: z.number().int(),
  path: z.string().max(1024),
  commit_sha: code,
  content_sha256: code,
});

export const intentDetailSchema = intentSchema.extend({
  spec: specRefSchema.nullable(),
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

/** `POST /v1/intents/:intent/specs` (B08, ADR-M39 §2.2). */
export const linkedSpecSchema = specRefSchema.extend({ intent: code });
export type LinkedSpecView = z.infer<typeof linkedSpecSchema>;

const planVersionSchema = z.object({
  version: z.number().int(),
  commit_sha: code.nullable(),
  plan_sha256: code,
  planned_files: z.array(z.string().max(1024)).max(1000),
  allowed_tools: z.array(code).max(10).nullable(),
  change_flags: z.array(code).max(50),
  created_at: time,
});
export type PlanVersionView = z.infer<typeof planVersionSchema>;

/** `POST /v1/intents/:intent/plans` (B09, ADR-M40 §2.3). */
export const submittedPlanSchema = planVersionSchema.extend({ intent: code });

/** `GET /v1/intents/:intent/plans` (B09). */
export const planListSchema = z.object({
  intent: code,
  items: z.array(planVersionSchema).max(10_000),
});

/** A run of an intent (C11, ADR-M42 §2.6): IDs, codes, counts and times. */
const runSchema = z.object({
  id,
  attempt: z.number().int(),
  status: code,
  stop_reason: code.nullable(),
  agent_version: code,
  iterations: z.number().int(),
  killed_by: id.nullable(),
  created_at: time,
  started_at: time.nullable(),
  finished_at: time.nullable(),
});
export type RunView = z.infer<typeof runSchema>;

/** `GET /v1/intents/:intent/runs` (C11). */
export const runListSchema = z.object({
  intent: code,
  items: z.array(runSchema).max(10_000),
});

/** `POST /v1/runs/:run/kill` (C11). */
export const killResultSchema = z.object({
  run: id,
  intent: code,
  status: code,
  already: z.boolean(),
  escalation: id.nullable(),
});

/** Token sums: strings of digits (task E04, ADR-M45 §2.4). */
const tokenSum = z.string().regex(/^[0-9]{1,20}$/);
/** Money: a decimal string with 6 decimals, never a JSON number (D-05 D6). */
const usd6 = z.string().regex(/^[0-9]{1,15}\.[0-9]{6}$/);

const costAmountsSchema = z.object({
  calls: z.number().int().min(0),
  input_tokens: tokenSum,
  output_tokens: tokenSum,
  cached_input_tokens: tokenSum,
  cost_usd: usd6,
  wasted_tokens: tokenSum,
  wasted_cost_usd: usd6,
});
export type CostAmountsView = z.infer<typeof costAmountsSchema>;

/** `GET /v1/cost/report` (E04, ADR-M45 §2.4). */
export const costReportSchema = z.object({
  report: z.object({
    scope: z.object({
      kind: z.enum(['tenant', 'project', 'intent']),
      project: code.optional(),
      intent: code.optional(),
    }),
    from: time,
    to: time,
    group_by: z.enum(['project', 'intent', 'model', 'status']),
    totals: costAmountsSchema,
    rows: z.array(costAmountsSchema.extend({ key: z.string().max(128).nullable() })).max(500),
    truncated: z.boolean(),
    freshness: z.object({
      latest_call_at: time.nullable(),
      last_recorded_at: time.nullable(),
      runs_in_progress: z.number().int().min(0),
    }),
  }),
});
export type CostReportView = z.infer<typeof costReportSchema>['report'];

/** Whole seconds, or null when there is nothing to measure (task E06, ADR-M47). */
const seconds = z.number().int().min(0);
const waitStatsSchema = z.object({
  count: z.number().int().min(0),
  avg_seconds: seconds.nullable(),
  max_seconds: seconds.nullable(),
  p50_seconds: seconds.nullable(),
  p90_seconds: seconds.nullable(),
});
export type WaitStatsView = z.infer<typeof waitStatsSchema>;

/** `GET /v1/metrics/gates` (E06, ADR-M47). */
export const gateMetricsSchema = z.object({
  metrics: z.object({
    scope: z.object({ kind: z.enum(['tenant', 'project']), project: code.optional() }),
    from: time,
    to: time,
    as_of: time,
    clock: z.literal('wall_clock'),
    filters: z.object({
      gate: code.nullable(),
      mode: code.nullable(),
      risk: code.nullable(),
    }),
    rows: z
      .array(
        z.object({
          project: code,
          gate: z.enum(['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8']),
          first_round: waitStatsSchema,
          after_changes: waitStatsSchema,
          auto_passed: z.number().int().min(0),
          open: z.object({ count: z.number().int().min(0), oldest_seconds: seconds.nullable() }),
        }),
      )
      .max(500),
    truncated: z.boolean(),
  }),
});
export type GateMetricsView = z.infer<typeof gateMetricsSchema>['metrics'];

/** `GET /v1/intents/:intent/specs` (B08). */
export const specListSchema = z.object({
  intent: code,
  items: z.array(specRefSchema).max(10_000),
});

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

// The agent register (task B13 AC7, ADR-M37 §2.8).
export const agentSchema = z.object({
  id,
  key: code,
  version: code,
  status: code,
  owner_id: id,
  model_ref: z.string().max(128).nullable(),
  instructions_ref: z.string().max(300),
  instructions_sha256: code,
  allowed_tools: z.array(code).max(32),
  max_autonomy: code,
  approved_environments: z.array(code).max(3),
  last_recertified_at: z.string().max(10).nullable(),
  recertification_due_on: z.string().max(10).nullable(),
  overdue: z.boolean(),
  updated_at: time,
});
export type AgentView = z.infer<typeof agentSchema>;
export const agentListSchema = z.object({ items: z.array(agentSchema).max(10_000) });

export const agentRoundSchema = z.object({
  agent: agentSchema,
  purpose: code,
  required: z.array(code).max(4),
  missing: z.array(code).max(4),
  approvals: z
    .array(
      z.object({
        id,
        agent_version: code,
        purpose: code,
        capacity: code,
        approver_id: id,
        created_at: time,
      }),
    )
    .max(4),
  completed: z.boolean(),
});
export type AgentRoundView = z.infer<typeof agentRoundSchema>;
export const agentDetailSchema = agentSchema.extend({
  rounds: z.array(agentRoundSchema).max(2),
});

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const packFileSchema = z.object({ uri: ref, sha256, size_bytes: z.number().int().min(0) });

/** An Evidence Pack version (E02, ADR-M48 §2.6). */
export const evidencePackSchema = z.object({
  intent: code,
  id,
  version: z.number().int().min(1),
  content_sha256: sha256,
  manifest: packFileSchema,
  markdown: packFileSchema,
  locale: code,
  disclosure_format: z.enum(['client_format', 'standard_note']),
  item_count: z.number().int().min(0),
  built_by: id.nullable(),
  built_at: time,
  sealed_at: time.nullable(),
  retention_hold: z.boolean(),
  purged_at: time.nullable(),
});
export type EvidencePackView = z.infer<typeof evidencePackSchema>;

/** `POST /v1/intents/:intent/evidence-packs` (E02). */
export const evidenceBuildSchema = z.object({ pack: evidencePackSchema, created: z.boolean() });
/** `GET /v1/intents/:intent/evidence-packs/:version` (E02). */
export const evidenceShowSchema = z.object({ pack: evidencePackSchema });
/** `GET /v1/intents/:intent/evidence-packs` (E02). */
export const evidenceListSchema = z.object({
  intent: code,
  packs: z.array(evidencePackSchema).max(100_000),
});
/** `GET /v1/intents/:intent/evidence-packs/:version/manifest|markdown` (E02). */
export const evidenceFileSchema = z.object({
  file: z.object({
    intent_id: id,
    version: z.number().int().min(1),
    name: z.enum(['manifest.json', 'pack.md']),
    media_type: z.enum(['application/json', 'text/markdown']),
    sha256,
    size_bytes: z.number().int().min(0),
    // A pack file is at most a few MB: refuse anything larger.
    content: z.string().max(64 * 1024 * 1024),
  }),
});
