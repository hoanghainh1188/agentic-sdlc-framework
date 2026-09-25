// Agent actions the platform never allows, or allows only with a HITL grant for that exact scope
// (handbook Ch.4 §4.7, codes table §2.1). These lists are not configuration: no project may change
// them. The policy engine checks them with `PolicyEngine.isForbidden` (design/D-03 section 7.3).

/** Never allowed for an agent, at any autonomy level, with no override. */
export const FORBIDDEN_AGENT_ACTIONS = [
  /** Bypass or disable audit, logging, monitoring, gates, hooks or scans. */
  'bypass_controls',
  /** Exfiltrate secrets or client data. */
  'exfiltrate_data',
  /** Change its own permissions, policies or autonomy level. */
  'change_own_permissions',
  /** Approve an artifact it created. */
  'approve_own_artifact',
  /** Act outside its risk budget or run contract. */
  'exceed_run_contract',
] as const;
export type ForbiddenAgentAction = (typeof FORBIDDEN_AGENT_ACTIONS)[number];

/** Forbidden unless explicitly granted for that exact scope by a HITL decision. */
export const GRANT_REQUIRED_AGENT_ACTIONS = [
  'delete_data',
  'incompatible_schema_change',
  'iam_or_security_boundary_change',
  'large_blast_radius_production_deploy',
] as const;
export type GrantRequiredAgentAction = (typeof GRANT_REQUIRED_AGENT_ACTIONS)[number];
