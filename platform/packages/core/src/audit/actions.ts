// Audit actions and their declared payload fields (ADR-M09 section 2.8).
//
// The audit log is never deleted and is kept at least 2 years (D-05 section 10, FR-44), so data
// written there can never be erased. Payloads therefore hold **only IDs, codes, hashes and
// versions**: never personal data, client data, free text, config text or record contents.
// `append` accepts only the fields declared here for the action, each with a strict format, and
// the canonical payload must fit in `MAX_AUDIT_PAYLOAD_BYTES`.
//
// Adding an action: add it below with the smallest set of fields that makes the event
// traceable, and a test. Reviewers check that no field can carry personal or client data.
// A field whose kind ends with `?` is optional (ADR-M20): it may be left out, never set to null;
// when present it follows the same format rule.
import { DbError } from '../db/errors.js';
import { isUuid } from '../db/tenant-id.js';

/**
 * - `uuid`: a platform ID (lowercase UUID)
 * - `sha256`: a lowercase hex SHA-256 digest
 * - `version`: a positive integer
 * - `code`: a short code such as `G3`, `INT-2026-0001` or an enum value (no spaces, max 64)
 */
export type AuditFieldKind = 'uuid' | 'sha256' | 'version' | 'code';

/** A declared field: its kind, with a trailing `?` when the field is optional. */
export type AuditFieldSpec = AuditFieldKind | `${AuditFieldKind}?`;

export interface AuditActionSpec {
  /** Entity the event is about; null for events without one. `entity_id` is then null too. */
  readonly entityType: string | null;
  readonly fields: Readonly<Record<string, AuditFieldSpec>>;
}

export const AUDIT_ACTIONS = {
  /** A tenant was created by the one-time bootstrap (B03, ADR-M26). Never its slug or name. */
  'tenant.created': { entityType: 'tenant', fields: {} },
  /** A user was created (B03 bootstrap). Never the name or e-mail address. */
  'user.created': { entityType: 'user', fields: {} },
  /** A personal API token was issued (B03). Never the token or its hash; the token ID is the entity. */
  'api_token.issued': { entityType: 'api_token', fields: { user_id: 'uuid' } },
  /** A personal API token was revoked (B03). Written once, on the first revocation. */
  'api_token.revoked': { entityType: 'api_token', fields: { user_id: 'uuid' } },
  /** A project configuration was created or replaced (FR-14, ADR-M13). Never the config text. */
  'config.changed': {
    entityType: 'project',
    fields: { version: 'version', config_hash: 'sha256' },
  },
  /** A project AI record was created or replaced (FR-19). Never the record contents. */
  'ai_record.changed': { entityType: 'project', fields: { version: 'version' } },
  /** An intent was created (FR-01, FR-03). Never the title or description. */
  'intent.created': {
    entityType: 'intent',
    fields: {
      code: 'code',
      project_id: 'uuid',
      risk_tier: 'code',
      data_class: 'code',
      max_autonomy: 'code',
    },
  },
  /** An intent moved to another status or gate. `current_gate` is left out when there is none. */
  'intent.state_changed': {
    entityType: 'intent',
    fields: { status: 'code', current_gate: 'code?' },
  },
  /** A spec was linked to an intent (FR-02). Never the path or the content. */
  'spec.linked': {
    entityType: 'intent',
    fields: { spec_ref_id: 'uuid', version: 'version', content_sha256: 'sha256' },
  },
  /** A plan was submitted for an intent. Never the file list or the summary. */
  'plan.submitted': {
    entityType: 'intent',
    fields: { plan_id: 'uuid', version: 'version', plan_sha256: 'sha256' },
  },
  /** A gate decision was recorded (FR-10, FR-17). Never a free-text reason (ADR-M20). */
  'gate.decided': {
    entityType: 'intent',
    fields: {
      decision_id: 'uuid',
      gate: 'code',
      decision: 'code',
      oversight_mode: 'code',
      input_sha256: 'sha256',
      config_hash: 'sha256',
      approver_role: 'code?',
      reason_code: 'code?',
      voids_decision_id: 'uuid?',
    },
  },
  /** A Run Contract was signed and stored for a new run (D-03 section 8, ADR-M22). */
  'run.contract_issued': {
    entityType: 'run',
    fields: {
      intent_id: 'uuid',
      attempt: 'version',
      contract_sha256: 'sha256',
      key_version: 'version',
    },
  },
  /** The runner refused the Run Contract of a known run; `reason` is a reject reason code. */
  'run.contract_rejected': { entityType: 'run', fields: { reason: 'code' } },
  /** An escalation was raised (FR-18, B11). Codes and IDs only, never the words of the package. */
  'escalation.created': {
    entityType: 'escalation',
    fields: {
      code: 'code',
      intent_id: 'uuid',
      trigger: 'code',
      route: 'code',
      severity: 'code',
      response_level: 'code',
      step: 'code',
      subject_sha256: 'sha256',
      run_id: 'uuid?',
      gate: 'code?',
    },
  },
  /** Nobody but producers holds any role of the route or governance (QUESTIONS #74). */
  'escalation.unrouted': { entityType: 'escalation', fields: { code: 'code' } },
  /** The holder of the current step was reminded (Ch.6 §6.5, QUESTIONS #75). */
  'escalation.reminded': { entityType: 'escalation', fields: { code: 'code', step: 'code' } },
  /** Nobody acknowledged in time: the escalation moved to the next step (Ch.6 §6.5). */
  'escalation.step_changed': {
    entityType: 'escalation',
    fields: { code: 'code', from_step: 'code', to_step: 'code' },
  },
  /** Governance, the last step, did not acknowledge in time either. Recorded once. */
  'escalation.ack_overdue': { entityType: 'escalation', fields: { code: 'code' } },
  /** The resolve deadline passed without a decision; governance takes over. Recorded once. */
  'escalation.resolve_overdue': {
    entityType: 'escalation',
    fields: { code: 'code', from_step: 'code' },
  },
  /** A Critical escalation passed its resolve deadline: the incident process is due (Ch.6 §6.7). */
  'escalation.incident_due': { entityType: 'escalation', fields: { code: 'code' } },
} as const satisfies Readonly<Record<string, AuditActionSpec>>;

export type AuditAction = keyof typeof AUDIT_ACTIONS;

type FieldValue<K> = K extends 'version' | 'version?' ? number : string;
type Fields<A extends AuditAction> = (typeof AUDIT_ACTIONS)[A]['fields'];
type OptionalKeys<A extends AuditAction> = {
  [F in keyof Fields<A>]: Fields<A>[F] extends `${string}?` ? F : never;
}[keyof Fields<A>];

export type AuditPayload<A extends AuditAction> = {
  readonly [F in Exclude<keyof Fields<A>, OptionalKeys<A>>]: FieldValue<Fields<A>[F]>;
} & {
  readonly [F in OptionalKeys<A>]?: FieldValue<Fields<A>[F]>;
};

/** Upper bound of the canonical JSON payload, in UTF-8 bytes. */
export const MAX_AUDIT_PAYLOAD_BYTES = 2048;

const SHA256 = /^[0-9a-f]{64}$/;
const CODE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

function isValidField(kind: AuditFieldKind, value: unknown): boolean {
  switch (kind) {
    case 'uuid':
      return isUuid(value);
    case 'sha256':
      return typeof value === 'string' && SHA256.test(value);
    case 'version':
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
    case 'code':
      return typeof value === 'string' && CODE.test(value);
  }
}

export function isAuditAction(action: unknown): action is AuditAction {
  return typeof action === 'string' && Object.hasOwn(AUDIT_ACTIONS, action);
}

/**
 * Checks an event against its declared spec and returns the payload with exactly the declared
 * fields. Throws `DbError('invalid_value')` for an unknown action, a missing, extra or badly
 * formatted field, or a wrong entity.
 */
export function checkAuditEvent(
  action: string,
  entityId: string | null,
  payload: Readonly<Record<string, unknown>>,
): { entityType: string | null; payload: Record<string, unknown> } {
  if (!isAuditAction(action)) throw invalid(`unknown audit action ${JSON.stringify(action)}`);
  const spec: AuditActionSpec = AUDIT_ACTIONS[action];
  if (spec.entityType === null ? entityId !== null : !isUuid(entityId)) {
    throw invalid(`${action}: entity ID must be ${spec.entityType ? 'a UUID' : 'null'}`);
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw invalid(`${action}: payload must be an object`);
  }
  const extra = Object.keys(payload).filter((key) => !Object.hasOwn(spec.fields, key));
  if (extra.length > 0) throw invalid(`${action}: undeclared payload fields ${extra.join(', ')}`);
  const checked: Record<string, unknown> = {};
  for (const [field, declared] of Object.entries(spec.fields)) {
    const optional = declared.endsWith('?');
    const kind = (optional ? declared.slice(0, -1) : declared) as AuditFieldKind;
    const value = payload[field];
    if (optional && value === undefined) continue;
    if (!isValidField(kind, value))
      throw invalid(`${action}: payload field ${field} must be a ${kind}`);
    checked[field] = value;
  }
  return { entityType: spec.entityType, payload: checked };
}

function invalid(message: string): DbError {
  return new DbError('invalid_value', message);
}
