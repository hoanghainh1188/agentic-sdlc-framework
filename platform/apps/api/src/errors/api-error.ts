// Every error the API returns has a stable code, an HTTP status and a message from the catalog
// (D-08 B03 AC4, NFR-08). Nothing else reaches the client: no stack trace, no SQL, no library text.
import type { ConfigIssue } from '@sdlc/config';
import {
  AGENT_REGISTER_ERROR_MESSAGES,
  AdminError,
  AgentRegisterError,
  AiRecordError,
  CommandError,
  DbError,
  EscalationError,
  RegistryError,
  TenantGuardError,
  type AdminErrorCode,
  type CommandErrorCode,
  type DbErrorCode,
  type EscalationErrorCode,
  type RegistryErrorCode,
} from '@sdlc/core';
import { t, type MessageKey } from '@sdlc/messages';

/** Codes of the error envelope. Each has the catalog key `api.error.<code>` (tested). */
export const API_ERROR_CODES = [
  'unauthorized',
  'rate_limited',
  'invalid_request',
  'not_found',
  'intent_not_found',
  'project_not_found',
  'forbidden',
  'approval_refused',
  'decision_not_allowed',
  'gate_not_supported',
  'gate_input_missing',
  'gate_not_current',
  'scope_not_allowed',
  'plan_refused',
  'project_not_active',
  'config_invalid',
  'issue_already_linked',
  'escalation_not_found',
  'escalation_not_open',
  'escalation_already_acknowledged',
  'escalation_decision_not_allowed',
  'ai_record_not_found',
  'ai_record_invalid',
  'ai_record_version_conflict',
  'user_not_found',
  'identity_not_found',
  'token_not_found',
  'agent_not_found',
  'agent_refused',
  'role_binding_not_found',
  'project_archived',
  'user_not_active',
  'self_action',
  'conflicting_role',
  'last_tenant_admin',
  'already_exists',
  'config_rejected',
  'config_version_conflict',
  'conflict',
  'not_ready',
  'internal',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

const ERROR_MESSAGE_KEYS: Readonly<Record<ApiErrorCode, MessageKey>> = {
  unauthorized: 'api.error.unauthorized',
  rate_limited: 'api.error.rate_limited',
  invalid_request: 'api.error.invalid_request',
  not_found: 'api.error.not_found',
  intent_not_found: 'api.error.intent_not_found',
  project_not_found: 'api.error.project_not_found',
  forbidden: 'api.error.forbidden',
  approval_refused: 'api.error.approval_refused',
  decision_not_allowed: 'api.error.decision_not_allowed',
  gate_not_supported: 'api.error.gate_not_supported',
  gate_input_missing: 'api.error.gate_input_missing',
  gate_not_current: 'api.error.gate_not_current',
  scope_not_allowed: 'api.error.scope_not_allowed',
  plan_refused: 'api.error.plan_refused',
  project_not_active: 'api.error.project_not_active',
  config_invalid: 'api.error.config_invalid',
  issue_already_linked: 'api.error.issue_already_linked',
  escalation_not_found: 'api.error.escalation_not_found',
  escalation_not_open: 'api.error.escalation_not_open',
  escalation_already_acknowledged: 'api.error.escalation_already_acknowledged',
  escalation_decision_not_allowed: 'api.error.escalation_decision_not_allowed',
  ai_record_not_found: 'api.error.ai_record_not_found',
  ai_record_invalid: 'api.error.ai_record_invalid',
  ai_record_version_conflict: 'api.error.ai_record_version_conflict',
  user_not_found: 'api.error.user_not_found',
  identity_not_found: 'api.error.identity_not_found',
  token_not_found: 'api.error.token_not_found',
  agent_not_found: 'api.error.agent_not_found',
  agent_refused: 'api.error.agent_refused',
  role_binding_not_found: 'api.error.role_binding_not_found',
  project_archived: 'api.error.project_archived',
  user_not_active: 'api.error.user_not_active',
  self_action: 'api.error.self_action',
  conflicting_role: 'api.error.conflicting_role',
  last_tenant_admin: 'api.error.last_tenant_admin',
  already_exists: 'api.error.already_exists',
  config_rejected: 'api.error.config_rejected',
  config_version_conflict: 'api.error.config_version_conflict',
  conflict: 'api.error.conflict',
  not_ready: 'api.error.not_ready',
  internal: 'api.error.internal',
};

export function errorMessageKey(code: ApiErrorCode): MessageKey {
  return ERROR_MESSAGE_KEYS[code];
}

/**
 * One problem in a request: where (`body.title`) and what (a zod issue code, or a configuration
 * message key). Never free text from the request: `message` is catalog text only (B13).
 */
export interface ErrorDetail {
  readonly path: string;
  readonly issue: string;
  readonly message?: string;
}

export class ApiError extends Error {
  override readonly name = 'ApiError';

  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    /** A refusal reason code from the registry or policy engine, for example `role_missing`. */
    readonly reason?: string,
    readonly details?: readonly ErrorDetail[],
    /** Configuration issues (B13 `config_rejected`); the filter renders them in the locale. */
    readonly configIssues?: readonly ConfigIssue[],
    /** Catalog text of `reason`, when it is not a gate refusal reason (B13 agent register). */
    readonly reasonText?: (locale: string) => string,
  ) {
    super(code);
  }
}

const REGISTRY: Readonly<Record<RegistryErrorCode, [number, ApiErrorCode]>> = {
  intent_not_found: [404, 'intent_not_found'],
  project_not_active: [409, 'project_not_active'],
  config_invalid: [409, 'config_invalid'],
  config_hash_mismatch: [409, 'config_invalid'],
  config_defaults_drift: [409, 'config_invalid'],
  decision_not_allowed: [422, 'decision_not_allowed'],
  approval_refused: [403, 'approval_refused'],
  issue_already_linked: [409, 'issue_already_linked'],
};

const COMMAND: Readonly<Record<CommandErrorCode, [number, ApiErrorCode]>> = {
  gate_not_supported: [422, 'gate_not_supported'],
  gate_input_missing: [409, 'gate_input_missing'],
  gate_not_current: [409, 'gate_not_current'],
  scope_not_allowed: [422, 'scope_not_allowed'],
  plan_refused: [409, 'plan_refused'],
  intent_not_found: [404, 'intent_not_found'],
  project_not_found: [404, 'project_not_found'],
  forbidden: [403, 'forbidden'],
};

/** Escalation refusals (B11). `frozen` and packet errors never come from these endpoints. */
const ESCALATION: Readonly<Record<EscalationErrorCode, [number, ApiErrorCode]>> = {
  not_found: [404, 'escalation_not_found'],
  forbidden: [403, 'forbidden'],
  not_open: [409, 'escalation_not_open'],
  already_acknowledged: [409, 'escalation_already_acknowledged'],
  decision_not_allowed: [422, 'escalation_decision_not_allowed'],
  intent_not_open: [409, 'escalation_not_open'],
  invalid_packet: [400, 'invalid_request'],
  response_level_too_low: [422, 'escalation_decision_not_allowed'],
  frozen: [409, 'conflict'],
};

/** Admin refusals (B13, ADR-M37 §2.6). */
const ADMIN: Readonly<Record<AdminErrorCode, [number, ApiErrorCode]>> = {
  forbidden: [403, 'forbidden'],
  project_not_found: [404, 'project_not_found'],
  user_not_found: [404, 'user_not_found'],
  identity_not_found: [404, 'identity_not_found'],
  token_not_found: [404, 'token_not_found'],
  role_binding_not_found: [404, 'role_binding_not_found'],
  project_archived: [409, 'project_archived'],
  user_not_active: [409, 'user_not_active'],
  self_action: [403, 'self_action'],
  conflicting_role: [409, 'conflicting_role'],
  last_tenant_admin: [409, 'last_tenant_admin'],
  already_exists: [409, 'already_exists'],
  invalid_value: [400, 'invalid_request'],
  config_rejected: [422, 'config_rejected'],
  config_version_conflict: [409, 'config_version_conflict'],
};

const DB: Partial<Readonly<Record<DbErrorCode, [number, ApiErrorCode]>>> = {
  invalid_value: [400, 'invalid_request'],
  conflict: [409, 'conflict'],
  reference_not_found: [400, 'invalid_request'],
};

/**
 * An agent register refusal (B13 AC7): the code is the `reason`, its text names the agent.
 * `not_permitted` and `not_an_approver` are 403; an unknown agent is 404; a bad value 400.
 */
export function agentApiError(error: AgentRegisterError, agentKey: string): ApiError {
  const text = (locale: string) =>
    t(
      AGENT_REGISTER_ERROR_MESSAGES[error.code],
      { key: agentKey, field: error.field ?? '-' },
      locale,
    );
  if (error.code === 'agent_not_found') return new ApiError(404, 'agent_not_found');
  if (error.code === 'invalid_input') {
    const details = [{ path: `body.${error.field ?? 'body'}`, issue: 'invalid' }];
    return new ApiError(400, 'invalid_request', undefined, details);
  }
  const forbidden = error.code === 'not_permitted' || error.code === 'not_an_approver';
  return new ApiError(
    forbidden ? 403 : 409,
    forbidden ? 'forbidden' : 'agent_refused',
    error.code,
    undefined,
    undefined,
    text,
  );
}

/** Maps any thrown value to an `ApiError`. Unknown errors become `internal` (500). */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof CommandError) return new ApiError(...COMMAND[error.code]);
  if (error instanceof AgentRegisterError) return agentApiError(error, '-');
  if (error instanceof AdminError) {
    const [status, code] = ADMIN[error.code];
    const details =
      error.extra.field === undefined
        ? undefined
        : [{ path: `body.${error.extra.field}`, issue: 'invalid' }];
    return new ApiError(status, code, error.extra.reason, details, error.extra.issues);
  }
  if (error instanceof EscalationError) return new ApiError(...ESCALATION[error.code]);
  if (error instanceof AiRecordError) {
    if (error.code === 'version_conflict') return new ApiError(409, 'ai_record_version_conflict');
    if (error.code === 'not_a_writer') return new ApiError(403, 'forbidden');
    const details =
      error.field === undefined ? undefined : [{ path: `body.${error.field}`, issue: 'invalid' }];
    return new ApiError(422, 'ai_record_invalid', error.code, details);
  }
  if (error instanceof RegistryError) {
    const [status, code] = REGISTRY[error.code];
    // A person without the gate's role is refused like any other missing permission.
    const refusedStatus = error.reason === 'role_missing' ? 403 : status;
    return new ApiError(refusedStatus, code, error.reason);
  }
  if (error instanceof DbError) {
    const mapped = DB[error.code];
    if (mapped) return new ApiError(...mapped);
  }
  if (error instanceof TenantGuardError) return new ApiError(500, 'internal');
  return new ApiError(500, 'internal');
}
