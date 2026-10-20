// The contract of one evaluation run (task L04, design/ADR-M81 §2.2, QUESTIONS #460). A second kind
// of Run Contract: the same Transit key and the same signed form (RFC 8785 canonical JSON), its own
// schema, no intent, no plan and no branch to push. The worker issues it, the runner verifies it
// before it creates a sandbox. Values are strings, integers and arrays only (no floating point).
//
// The kind is part of the signed bytes, so a Run Contract of a real run can never be taken for an
// evaluation contract or the other way round: each schema refuses the other's fields.
import {
  budget,
  GIT_SHA,
  HOST,
  MODEL,
  positiveInt,
  REPO,
  SIGNATURE,
  sortedSet,
  text,
  timestamp,
  UUID,
  VERSION_LABEL,
  type Check,
} from './contract-checks.js';

/** 2 (L07, ADR-M85 §2.10): the task set's kind and commit; the version only for a `folder` set. */
export const EVALUATION_CONTRACT_SCHEMA_VERSION = 2;
export const EVALUATION_CONTRACT_KIND = 'evaluation';

export interface EvaluationRunContract {
  readonly schema_version: typeof EVALUATION_CONTRACT_SCHEMA_VERSION;
  readonly kind: typeof EVALUATION_CONTRACT_KIND;
  readonly evaluation_run_id: string;
  readonly evaluation_id: string;
  /** `EVAL-YYYY-NNNN`: the `intent_id` label of the run's model calls (QUESTIONS #462). */
  readonly evaluation_code: string;
  readonly tenant_id: string;
  readonly project_id: string;
  /** `owner/name` on the Git host: the project's repository. */
  readonly repo: string;
  /** The commit the run starts from: the task set's (`folder`) or the task's (`project`). */
  readonly base_sha: string;
  readonly configuration_id: string;
  readonly task_id: string;
  /** `folder`: a numbered task set in the runner; `project`: the project's task cards (L07). */
  readonly task_set_kind: 'folder' | 'project';
  /** The number of a `folder` set; null for `project`. */
  readonly task_set_version: number | null;
  /** The default branch's commit the task card is read at (`project`); null for `folder`. */
  readonly task_set_commit: string | null;
  readonly run_index: number;
  /** Grows when a preempted run is queued again; one contract per attempt. */
  readonly attempt: number;
  readonly agent_version: string;
  /** The one model of the configuration; it is also the only entry of `allowed_models`. */
  readonly model: string;
  /** Cost cap in USD, a decimal string: never above what is left of the evaluation's budget. */
  readonly max_budget_usd: string;
  readonly max_iterations: number;
  readonly max_duration_min: number;
  readonly loop_threshold: number;
  readonly allowed_models: readonly string[];
  /** Host names the sandbox may reach (LiteLLM and the package proxy only; ADR-M25). */
  readonly egress_allowlist: readonly string[];
  readonly issued_at: string;
  readonly expires_at: string;
}

export interface EvaluationContractEnvelope {
  readonly contract: EvaluationRunContract;
  readonly signature: string;
}

export type EvaluationContractValidation =
  | { readonly ok: true; readonly contract: EvaluationRunContract }
  | { readonly ok: false; readonly field: string };

const CODE = /^[a-z][a-z0-9_.-]{0,63}$/;
const EVAL_CODE = /^EVAL-[0-9]{4}-[0-9]{4,9}$/;

const FIELDS: Readonly<Record<keyof EvaluationRunContract, Check>> = {
  schema_version: (value) => value === EVALUATION_CONTRACT_SCHEMA_VERSION,
  kind: (value) => value === EVALUATION_CONTRACT_KIND,
  evaluation_run_id: text(UUID),
  evaluation_id: text(UUID),
  evaluation_code: text(EVAL_CODE),
  tenant_id: text(UUID),
  project_id: text(UUID),
  repo: text(REPO),
  base_sha: text(GIT_SHA),
  configuration_id: text(CODE),
  task_id: text(CODE),
  task_set_kind: (value) => value === 'folder' || value === 'project',
  task_set_version: (value) => value === null || positiveInt(value),
  task_set_commit: (value) => value === null || text(GIT_SHA)(value),
  run_index: positiveInt,
  attempt: positiveInt,
  agent_version: text(VERSION_LABEL),
  model: text(MODEL),
  max_budget_usd: budget,
  max_iterations: positiveInt,
  max_duration_min: positiveInt,
  loop_threshold: positiveInt,
  allowed_models: sortedSet(MODEL, 1),
  egress_allowlist: sortedSet(HOST, 1),
  issued_at: timestamp,
  expires_at: timestamp,
};

/** The contract fields, in schema order. */
export const EVALUATION_CONTRACT_FIELDS = Object.keys(
  FIELDS,
) as readonly (keyof EvaluationRunContract)[];

/**
 * Checks a value against the evaluation contract schema: every field present in its format, no
 * other field, `expires_at` after `issued_at`, and the model the only allowed model. Returns the
 * first field that fails.
 */
export function validateEvaluationContract(value: unknown): EvaluationContractValidation {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, field: '(contract)' };
  }
  const record = value as Record<string, unknown>;
  const extra = Object.keys(record).find((key) => !Object.hasOwn(FIELDS, key));
  if (extra !== undefined) return { ok: false, field: extra };
  for (const field of EVALUATION_CONTRACT_FIELDS) {
    if (!FIELDS[field](record[field])) return { ok: false, field };
  }
  if (Date.parse(record.expires_at as string) <= Date.parse(record.issued_at as string)) {
    return { ok: false, field: 'expires_at' };
  }
  if ((record.task_set_kind === 'folder') !== (record.task_set_version !== null)) {
    return { ok: false, field: 'task_set_version' };
  }
  if ((record.task_set_kind === 'project') !== (record.task_set_commit !== null)) {
    return { ok: false, field: 'task_set_commit' };
  }
  const allowed = record.allowed_models as readonly string[];
  if (allowed.length !== 1 || allowed[0] !== record.model) {
    return { ok: false, field: 'allowed_models' };
  }
  return { ok: true, contract: value as EvaluationRunContract };
}

export interface ParsedEvaluationContractEnvelope {
  readonly contract: EvaluationRunContract;
  readonly signature: string;
  readonly keyVersion: number;
}

/**
 * Checks the shape of an envelope received by the runner: exactly `contract` and `signature`, a
 * valid evaluation contract and a `vault:v<N>:…` signature. Undefined when anything is malformed.
 * The signature itself is not verified here.
 */
export function parseEvaluationContractEnvelope(
  value: unknown,
): ParsedEvaluationContractEnvelope | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== 'contract' || keys[1] !== 'signature') return undefined;
  const validation = validateEvaluationContract(record.contract);
  const signature = record.signature;
  if (!validation.ok || typeof signature !== 'string' || signature.length > 512) return undefined;
  const match = SIGNATURE.exec(signature);
  if (!match) return undefined;
  return { contract: validation.contract, signature, keyVersion: Number(match[1]) };
}
