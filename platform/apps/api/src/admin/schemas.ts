// Request schemas of the admin endpoints (task B13, ADR-M37 §2.6). Shapes only; the core admin
// services check the values again, so the operator commands follow the same rules.
import { AGENT_KEY_PATTERN, PROJECT_ROLES } from '@sdlc/contracts';
import {
  API_TOKEN_MAX_LIFETIME_DAYS,
  API_TOKEN_NAME_PATTERN,
  EXTERNAL_ID_PATTERN,
  EXTERNAL_LOGIN_PATTERN,
  MAX_CONFIG_YAML_BYTES,
  MAX_EMAIL_LENGTH,
  MAX_NAME_LENGTH,
  PROJECT_SLUG_PATTERN,
} from '@sdlc/core';
import { z } from 'zod';

export const projectSlugSchema = z.string().regex(PROJECT_SLUG_PATTERN);
export const idSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

const name = z.string().min(1).max(MAX_NAME_LENGTH);
const email = z.string().min(3).max(MAX_EMAIL_LENGTH);
const repoFullName = z.string().min(3).max(140);
const branch = z.string().min(1).max(100);

export const createProjectSchema = z.strictObject({
  slug: projectSlugSchema,
  name,
  repo_full_name: repoFullName,
  default_branch: branch.optional(),
  git_provider: z.enum(['github']).optional(),
});

export const updateProjectSchema = z.strictObject({
  name: name.optional(),
  repo_full_name: repoFullName.optional(),
  default_branch: branch.optional(),
});

export const createUserSchema = z.strictObject({ email, display_name: name });

export const updateUserSchema = z.strictObject({
  email: email.optional(),
  display_name: name.optional(),
});

/** The account is identified by its numeric ID, given as a string (QUESTIONS #45). */
export const linkIdentitySchema = z.strictObject({
  provider: z.enum(['github']).optional(),
  external_id: z.string().regex(EXTERNAL_ID_PATTERN),
  external_login: z.string().regex(EXTERNAL_LOGIN_PATTERN),
});

export const grantRoleSchema = z.strictObject({
  user_id: idSchema,
  role: z.enum(PROJECT_ROLES),
});

export const grantTenantAdminSchema = z.strictObject({ user_id: idSchema });

export const saveConfigSchema = z.strictObject({
  /** The version read; 0 when the project has no stored configuration. */
  expected_version: z.number().int().min(0),
  config_yaml: z.string().max(MAX_CONFIG_YAML_BYTES),
});

/** `?include_revoked=true` (roles, tenant admins) or `?include_unlinked=true` (identities). */
export const historyQuerySchema = z.strictObject({
  include_revoked: z.enum(['true', 'false']).optional(),
  include_unlinked: z.enum(['true', 'false']).optional(),
});

/** A new personal token (B13 AC5): a short name code and an optional lifetime in days. */
export const issueTokenSchema = z.strictObject({
  name: z.string().regex(API_TOKEN_NAME_PATTERN),
  days: z.number().int().min(1).max(API_TOKEN_MAX_LIFETIME_DAYS).optional(),
});

// The agent register (B13 AC7). The core rules (`agents/rules.ts`) check the formats again.
export const agentKeySchema = z.string().regex(AGENT_KEY_PATTERN);
const tools = z.array(z.string().max(64)).max(32);
const environments = z.array(z.enum(['sandbox', 'staging', 'production'])).max(3);
const autonomy = z.enum(['L0', 'L1', 'L2']);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const registerAgentSchema = z.strictObject({
  key: agentKeySchema,
  version: z.string().max(64),
  owner_id: idSchema,
  model_ref: z.string().max(128).nullable().optional(),
  instructions_ref: z.string().max(300),
  instructions_sha256: sha256,
  allowed_tools: tools.default([]),
  max_autonomy: autonomy,
  approved_environments: environments.default(['sandbox']),
});

export const updateAgentSchema = z.strictObject({
  version: z.string().max(64),
  model_ref: z.string().max(128).nullable().optional(),
  instructions_ref: z.string().max(300).optional(),
  instructions_sha256: sha256.optional(),
  allowed_tools: tools.optional(),
  max_autonomy: autonomy.optional(),
  approved_environments: environments.optional(),
});

export const approveAgentSchema = z.strictObject({
  purpose: z.enum(['activate', 'retire']),
  as: z.enum(['owner', 'person_a', 'person_b', 'governance']),
  reason_code: z.string().max(64).optional(),
});

export const stopAgentSchema = z.strictObject({ reason_code: z.string().max(64) });
export const changeOwnerSchema = z.strictObject({ owner_id: idSchema });
export const recertifySchema = z.strictObject({
  day: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});
