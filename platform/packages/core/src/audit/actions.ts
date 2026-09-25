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
import { DbError } from '../db/errors.js';
import { isUuid } from '../db/tenant-id.js';

/**
 * - `uuid`: a platform ID (lowercase UUID)
 * - `sha256`: a lowercase hex SHA-256 digest
 * - `version`: a positive integer
 * - `code`: a short code such as `G3`, `INT-2026-0001` or an enum value (no spaces, max 64)
 */
export type AuditFieldKind = 'uuid' | 'sha256' | 'version' | 'code';

export interface AuditActionSpec {
  /** Entity the event is about; null for events without one. `entity_id` is then null too. */
  readonly entityType: string | null;
  readonly fields: Readonly<Record<string, AuditFieldKind>>;
}

export const AUDIT_ACTIONS = {
  /** A project configuration was created or replaced (FR-14, ADR-M13). Never the config text. */
  'config.changed': {
    entityType: 'project',
    fields: { version: 'version', config_hash: 'sha256' },
  },
  /** A project AI record was created or replaced (FR-19). Never the record contents. */
  'ai_record.changed': { entityType: 'project', fields: { version: 'version' } },
} as const satisfies Readonly<Record<string, AuditActionSpec>>;

export type AuditAction = keyof typeof AUDIT_ACTIONS;

type FieldValue<K> = K extends 'version' ? number : string;

export type AuditPayload<A extends AuditAction> = {
  readonly [F in keyof (typeof AUDIT_ACTIONS)[A]['fields']]: FieldValue<
    (typeof AUDIT_ACTIONS)[A]['fields'][F]
  >;
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
  for (const [field, kind] of Object.entries(spec.fields)) {
    const value = payload[field];
    if (!isValidField(kind, value))
      throw invalid(`${action}: payload field ${field} must be a ${kind}`);
    checked[field] = value;
  }
  return { entityType: spec.entityType, payload: checked };
}

function invalid(message: string): DbError {
  return new DbError('invalid_value', message);
}
