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
import { isUsd } from '../cost/money.js';
import { DbError } from '../db/errors.js';
import { isUuid } from '../db/tenant-id.js';

/**
 * - `uuid`: a platform ID (lowercase UUID)
 * - `sha256`: a lowercase hex SHA-256 digest
 * - `version`: a positive integer
 * - `count`: a non-negative integer (iterations, tokens, percent)
 * - `code`: a short code such as `expired` or `G5` (letters, digits, `_ . : -`; max 64)
 * - `decimal`: an amount of money in USD as a decimal string with at most 6 decimals, never a
 *   float (D-05 D6; C07)
 */
export type RunEventFieldKind = 'uuid' | 'sha256' | 'version' | 'count' | 'code' | 'decimal';
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
  /**
   * The runner ended a run that had not reached a final status because its sandbox was lost: the
   * runner restarted (`stop_reason` `runner_restarted`) or the sweep found the sandbox without its
   * process (`sandbox_lost`). `previous_status` is the run status before `failed` (C04, ADR-M25).
   */
  run_abandoned: { previous_status: 'code' },
  /**
   * The runner started the agent in the sandbox with the contract's caps (C05, ADR-M29). The model
   * name is not repeated here: model names may hold `/` or `@`; `cost_records` has the model.
   */
  agent_started: { max_iterations: 'count', max_duration_min: 'count' },
  /**
   * The runner interrupted the agent (C05): `reason` `max_duration`; `method` `interrupt` (the agent
   * stopped within the grace period) or `kill` (the sandbox was removed without waiting).
   */
  agent_stopped: { reason: 'code', method: 'code' },
  /**
   * The agent run ended (C05, ADR-M29). `outcome`: `finished`, `max_iterations`, `max_duration`,
   * `stuck`, `agent_error`. `commit`: `committed` (the runner committed what the agent left, QUESTIONS
   * #80) or `nothing`; left out when the runner did not commit. `head_sha` is the final `HEAD`;
   * `changed_files` counts the files changed since `base_sha` (the paths are client data).
   */
  agent_finished: {
    outcome: 'code',
    iterations: 'count',
    changed_files: 'count?',
    head_sha: 'code?',
    commit: 'code?',
  },
  /** An agent call failed (C05); `reason` is an `AgentErrorCode` or `model_unreachable`. */
  agent_failed: { reason: 'code' },
  /**
   * The proposal of an L1 run was computed in the runner's clone and stored as evidence (C06
   * session 2b, ADR-M33 §2.9). The URI and the paths stay in `evidence_items` and the file.
   */
  proposal_stored: { sha256: 'sha256', size_bytes: 'count', changed_files: 'count' },
  /**
   * The worker issued the run's capped virtual key (C07, ADR-M34 §2.6). `limited_by`: which budget
   * set the cap, `run`, `intent` or `tenant` (the smallest remainder). Never the key or its ID.
   */
  key_issued: { max_budget_usd: 'decimal', limited_by: 'code' },
  /**
   * The runner's spend check reached the warning share of the key's cap (C07): once per run.
   * `percent` is the share used when it was read.
   */
  budget_warning: { spend_usd: 'decimal', max_budget_usd: 'decimal', percent: 'count' },
  /**
   * The full diff of the run against `base_sha`, computed in the runner's clone from the sandbox's
   * workspace, stored as evidence `diff` (C07, ADR-M34 §2.2). The URI and the paths stay in
   * `evidence_items` and the file.
   */
  diff_stored: { sha256: 'sha256', size_bytes: 'count', changed_files: 'count' },
  /**
   * The runner's check of the run's changes, at the end of the run (C07, QUESTIONS #130, ADR-M34
   * §2.3): counts only. `paths_sha256` is the SHA-256 of the sorted changed paths (G5 binds to it);
   * `out_of_scope` counts paths outside the plan, `instruction_files` paths the agent reads as
   * instructions (QUESTIONS #126). The paths themselves are client data and never stored here.
   */
  changes_checked: {
    changed_files: 'count',
    out_of_scope: 'count',
    instruction_files: 'count',
    paths_sha256: 'sha256',
  },
} as const satisfies Readonly<Record<string, Readonly<Record<string, RunEventFieldSpec>>>>;

export type RunEventType = keyof typeof RUN_EVENT_TYPES;

type FieldValue<K> = K extends
  'uuid' | 'uuid?' | 'sha256' | 'sha256?' | 'code' | 'code?' | 'decimal' | 'decimal?'
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
    case 'decimal':
      return isUsd(value);
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
