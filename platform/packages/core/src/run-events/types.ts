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
  /**
   * The runner pushed the run's checked changes as one commit on `agent/INT-…` (C08, ADR-M38
   * §2.2): `head_sha` is the commit the runner made from the stored diff (never what the sandbox
   * reported) and that the Git host now shows for the branch; `diff_sha256` and `paths_sha256` are
   * the values G5 checked. `parent_sha` is the commit it was made on (the run's base).
   */
  branch_pushed: {
    head_sha: 'code',
    parent_sha: 'code',
    diff_sha256: 'sha256',
    paths_sha256: 'sha256',
  },
  /**
   * The runner will not push this run (C08, QUESTIONS #156): a final cause a person decides on,
   * such as `empty_diff`, `diff_mismatch` (the stored diff is not the one G5 checked) or
   * `branch_moved` (someone else changed `agent/INT-…`).
   */
  publish_refused: { reason: 'code' },
  /** A push attempt failed for a cause that may pass (Git host, network, token); C08. */
  publish_failed: { reason: 'code' },
  /**
   * What G6 read from the Git host about the run's pull request (C08 PR 2, ADR-M38 §2.7): the
   * pull request's state and head, the result of the checks G6 waits for (`state`: `passed`,
   * `failed`, `pending`), the SHA-256 of their sorted names and conclusions (the names stay on the
   * Git host), and the open security findings per severity (`findings`: `known`, `not_enabled`,
   * `forbidden`). Recorded when it changed; G6 decides from the latest one.
   */
  ci_checked: {
    pr_number: 'count',
    pr_state: 'code',
    head_sha: 'code',
    state: 'code',
    checks_sha256: 'sha256',
    findings: 'code',
    critical: 'count',
    high: 'count',
    medium: 'count',
    low: 'count',
  },
  /**
   * What G7 read about the run's pull request (E01, ADR-M41 §2.3): its state and head, the merge
   * commit and who merged it (`merger`: `person`, `producer`, `bot`, `unknown`; never the account),
   * the SHA-256 of the latest review decisions (review IDs, states, commits; never a login or a
   * text), the counts of approvals and requests for changes of the head, and of the commit authors
   * with and without an account. Recorded when it changed; G7 decides from the latest one.
   */
  g7_checked: {
    pr_number: 'count',
    pr_state: 'code',
    head_sha: 'code',
    merge_commit_sha: 'code?',
    merger: 'code?',
    reviews_sha256: 'sha256',
    approvals: 'count',
    changes_requested: 'count',
    commit_authors: 'count',
    commits_without_account: 'count',
  },
  /**
   * G7 passed: a person merged the run's pull request with the approved head (E01 AC5). The merge
   * commit is the source commit of the release (E03).
   */
  pr_merged: { pr_number: 'count', head_sha: 'code', merge_commit_sha: 'code?' },
  /**
   * A person (or an operator, actor `system`) used the kill switch (C11, ADR-M42): the run was
   * `previous_status`; `source` is `api`, `github_comment` or `ops`. Who killed is in
   * `runs.killed_by` and the audit event `run.kill_requested`.
   */
  kill_requested: { previous_status: 'code', source: 'code' },
  /**
   * The runner revoked a short-lived GitHub token right after its use (C11, ADR-M42 §2.4): `token`
   * is `clone`, `push` or (E01 PR 2) `feedback`. `token_revoke_failed` gives a `GitHostErrorCode`; the token then expires
   * by itself within the hour.
   */
  token_revoked: { token: 'code' },
  token_revoke_failed: { token: 'code', reason: 'code' },
  /**
   * A single-use wrapping token of the run was already used when the runner opened it (C11,
   * ADR-M38 §2.3, ADR-M42 §2.5): `token` is `clone`, `push`, `virtual_key` or (E01 PR 2)
   * `feedback`. Someone else may
   * hold the secret: the run fails and its escalation goes to the security route.
   */
  wrap_token_reused: { token: 'code' },
  /**
   * The diff of a killed run could not be stored as evidence (C11, QUESTIONS #183): the store is
   * best-effort and never delays the kill. `reason` is a code (`timeout`, `unavailable`, …).
   */
  kill_evidence_failed: { reason: 'code' },
  /**
   * The runner read the feedback of the request for changes the run answers (E01 PR 2, ADR-M41
   * §2.7, QUESTIONS #179): `source` is `review` or `comment`; the text's length in characters
   * after the cap, whether it was cut (`truncated`: `yes`, `no`) and the review's line comments.
   * Counts only: the text itself goes to the agent's prompt in memory, never here.
   */
  feedback_read: { source: 'code', chars: 'count', truncated: 'code', comments: 'count' },
  /**
   * The feedback of the request for changes cannot be used, so the run never starts its agent
   * (E01 PR 2): `reason` is a code (`review_withdrawn`, `identity_unlinked`, `author_mismatch`,
   * `git_host_unavailable`, …). Recorded by the worker before the key, or by the runner.
   */
  feedback_unavailable: { reason: 'code' },
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
