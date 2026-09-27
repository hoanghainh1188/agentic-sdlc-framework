// Every error the API returns has a stable code, an HTTP status and a message from the catalog
// (D-08 B03 AC4, NFR-08). Nothing else reaches the client: no stack trace, no SQL, no library text.
import {
  CommandError,
  DbError,
  EscalationError,
  RegistryError,
  TenantGuardError,
  type CommandErrorCode,
  type DbErrorCode,
  type EscalationErrorCode,
  type RegistryErrorCode,
} from '@sdlc/core';
import type { MessageKey } from '@sdlc/messages';

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
  'project_not_active',
  'config_invalid',
  'escalation_not_found',
  'escalation_not_open',
  'escalation_already_acknowledged',
  'escalation_decision_not_allowed',
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
  project_not_active: 'api.error.project_not_active',
  config_invalid: 'api.error.config_invalid',
  escalation_not_found: 'api.error.escalation_not_found',
  escalation_not_open: 'api.error.escalation_not_open',
  escalation_already_acknowledged: 'api.error.escalation_already_acknowledged',
  escalation_decision_not_allowed: 'api.error.escalation_decision_not_allowed',
  conflict: 'api.error.conflict',
  not_ready: 'api.error.not_ready',
  internal: 'api.error.internal',
};

export function errorMessageKey(code: ApiErrorCode): MessageKey {
  return ERROR_MESSAGE_KEYS[code];
}

/** One problem in a request: where (`body.title`) and what (a zod issue code). Never free text. */
export interface ErrorDetail {
  readonly path: string;
  readonly issue: string;
}

export class ApiError extends Error {
  override readonly name = 'ApiError';

  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    /** A refusal reason code from the registry or policy engine, for example `role_missing`. */
    readonly reason?: string,
    readonly details?: readonly ErrorDetail[],
  ) {
    super(code);
  }
}

const REGISTRY: Readonly<Record<RegistryErrorCode, [number, ApiErrorCode]>> = {
  intent_not_found: [404, 'intent_not_found'],
  project_not_active: [409, 'project_not_active'],
  config_invalid: [409, 'config_invalid'],
  config_hash_mismatch: [409, 'config_invalid'],
  decision_not_allowed: [422, 'decision_not_allowed'],
  approval_refused: [403, 'approval_refused'],
};

const COMMAND: Readonly<Record<CommandErrorCode, [number, ApiErrorCode]>> = {
  gate_not_supported: [422, 'gate_not_supported'],
  gate_input_missing: [409, 'gate_input_missing'],
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

const DB: Partial<Readonly<Record<DbErrorCode, [number, ApiErrorCode]>>> = {
  invalid_value: [400, 'invalid_request'],
  conflict: [409, 'conflict'],
  reference_not_found: [400, 'invalid_request'],
};

/** Maps any thrown value to an `ApiError`. Unknown errors become `internal` (500). */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof CommandError) return new ApiError(...COMMAND[error.code]);
  if (error instanceof EscalationError) return new ApiError(...ESCALATION[error.code]);
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
