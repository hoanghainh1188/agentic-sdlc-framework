// Run event types and their declared payload fields (design/D-05 section 6.4, ADR-M22 section 2.5).
//
// `run_events` is append-only and kept as evidence, so data written there can never be erased.
// Payloads therefore hold **only IDs, codes, hashes, versions and counts**: never free text,
// personal data (names, e-mail addresses, account names) or client data (paths, code, logs).
// `append` accepts only the fields declared here for the event type, each with a strict format;
// the database CHECK `run_event_payload_is_coded` refuses anything else as a backstop.
//
// Adding an event type (C04, C07, C11…): add it below with the smallest set of fields that makes
// the event traceable, and a test. Reviewers check that no field can carry personal or client data.
// A field whose kind ends with `?` is optional: it may be left out, never set to null.
import { DbError } from '../db/errors.js';
import { isUuid } from '../db/tenant-id.js';

/**
 * - `uuid`: a platform ID (lowercase UUID)
 * - `sha256`: a lowercase hex SHA-256 digest
 * - `version`: a positive integer
 * - `count`: a non-negative integer (iterations, tokens, percent)
 * - `code`: a short code such as `expired` or `G5` (letters, digits, `_ . : -`; max 64)
 */
export type RunEventFieldKind = 'uuid' | 'sha256' | 'version' | 'count' | 'code';
export type RunEventFieldSpec = RunEventFieldKind | `${RunEventFieldKind}?`;

export const RUN_EVENT_TYPES = {
  /** The worker issued and stored the signed Run Contract (C02). */
  contract_issued: { contract_sha256: 'sha256', key_version: 'version' },
  /** The runner verified the contract and may start the sandbox (C02). */
  contract_accepted: { contract_sha256: 'sha256', key_version: 'version' },
  /** The runner refused the contract; `reason` is a `RunContractRejectReason` (C02). */
  contract_rejected: { reason: 'code' },
  /**
   * The runner cloned the repository at `base_sha` and created the `agent/INT-…` branch in the
   * run's workspace (C04, ADR-M25). The branch name is in the contract, not repeated here.
   */
  workspace_prepared: { base_sha: 'code', duration_ms: 'count' },
  /** The runner created the sandbox container from the project image, pinned by digest (C04). */
  sandbox_created: { image_sha256: 'sha256' },
  /** The sandbox passed its health check (C04). */
  sandbox_ready: { duration_ms: 'count' },
  /** Provisioning stopped before the sandbox was ready; `reason` is a `ProvisioningFailure` (C04). */
  provisioning_failed: { reason: 'code' },
  /**
   * The runner removed the sandbox, its network and its workspace (C04). `reason` is a
   * `TeardownReason` code (`finished`, `failed`, `orphan`, …).
   */
  sandbox_removed: { reason: 'code', duration_ms: 'count' },
} as const satisfies Readonly<Record<string, Readonly<Record<string, RunEventFieldSpec>>>>;

export type RunEventType = keyof typeof RUN_EVENT_TYPES;

type FieldValue<K> = K extends 'uuid' | 'uuid?' | 'sha256' | 'sha256?' | 'code' | 'code?'
  ? string
  : number;
type Fields<T extends RunEventType> = (typeof RUN_EVENT_TYPES)[T];
type OptionalKeys<T extends RunEventType> = {
  [F in keyof Fields<T>]: Fields<T>[F] extends `${string}?` ? F : never;
}[keyof Fields<T>];

export type RunEventPayload<T extends RunEventType> = {
  readonly [F in Exclude<keyof Fields<T>, OptionalKeys<T>>]: FieldValue<Fields<T>[F]>;
} & {
  readonly [F in OptionalKeys<T>]?: FieldValue<Fields<T>[F]>;
};

/** Upper bound of the payload (same as the audit log and the database CHECK). */
export const MAX_RUN_EVENT_PAYLOAD_BYTES = 2048;

const SHA256 = /^[0-9a-f]{64}$/;
// No spaces (no sentences) and no '@' (no e-mail addresses).
const CODE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

function isValidField(kind: RunEventFieldKind, value: unknown): boolean {
  switch (kind) {
    case 'uuid':
      return isUuid(value);
    case 'sha256':
      return typeof value === 'string' && SHA256.test(value);
    case 'version':
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
    case 'count':
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    case 'code':
      return typeof value === 'string' && CODE.test(value);
  }
}

export function isRunEventType(type: unknown): type is RunEventType {
  return typeof type === 'string' && Object.hasOwn(RUN_EVENT_TYPES, type);
}

/**
 * Checks a payload against the declared fields of its event type and returns exactly those
 * fields. Throws `DbError('invalid_value')` for an unknown type or a missing, extra or badly
 * formatted field.
 */
export function checkRunEvent(
  type: string,
  payload: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  if (!isRunEventType(type)) throw invalid(`unknown run event type ${JSON.stringify(type)}`);
  const fields: Readonly<Record<string, RunEventFieldSpec>> = RUN_EVENT_TYPES[type];
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw invalid(`${type}: payload must be an object`);
  }
  const extra = Object.keys(payload).filter((key) => !Object.hasOwn(fields, key));
  if (extra.length > 0) throw invalid(`${type}: undeclared payload fields ${extra.join(', ')}`);
  const checked: Record<string, unknown> = {};
  for (const [field, declared] of Object.entries(fields)) {
    const optional = declared.endsWith('?');
    const kind = (optional ? declared.slice(0, -1) : declared) as RunEventFieldKind;
    const value = payload[field];
    if (optional && value === undefined) continue;
    if (!isValidField(kind, value))
      throw invalid(`${type}: payload field ${field} must be a ${kind}`);
    checked[field] = value;
  }
  return checked;
}

function invalid(message: string): DbError {
  return new DbError('invalid_value', message);
}
