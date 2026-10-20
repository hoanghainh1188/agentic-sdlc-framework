// The check of a project's evaluation task (task L07, design/ADR-M85 §2.5, QUESTIONS #488): its
// contract and the handoff from the worker to the runner.
//
// The contract is a third kind of Run Contract: the same Transit key and the same signed form
// (RFC 8785 canonical JSON), its own schema. It names the task, the project's repository, the
// card's commit and SHA-256, and the base and merge commits. No path of the project and no spec:
// the runner reads them from the card, whose SHA-256 it checks. No agent, no model, no budget.
//
// The check runs on the evaluation queue (`sdlc-runner-eval`, free slots only). Inputs and results
// in Temporal are IDs, codes, a hash and one single-use OpenBao wrapping token.
import {
  GIT_SHA,
  positiveInt,
  REPO,
  SHA256,
  SIGNATURE,
  text,
  timestamp,
  UUID,
  type Check,
} from './contract-checks.js';

export const TASK_CHECK_CONTRACT_SCHEMA_VERSION = 1;
export const TASK_CHECK_CONTRACT_KIND = 'evaluation_task_check';

export interface TaskCheckContract {
  readonly schema_version: typeof TASK_CHECK_CONTRACT_SCHEMA_VERSION;
  readonly kind: typeof TASK_CHECK_CONTRACT_KIND;
  /** The task's platform ID (`evaluation_tasks.id`). */
  readonly evaluation_task_id: string;
  readonly tenant_id: string;
  readonly project_id: string;
  /** `owner/name` on the Git host: the project's repository. */
  readonly repo: string;
  /** The task ID, as in the card's file name. */
  readonly task_id: string;
  readonly card_commit: string;
  readonly card_sha256: string;
  readonly base_sha: string;
  readonly merge_sha: string;
  /** Grows when a check is handed over again (a lost runner, a real run took the slot). */
  readonly attempt: number;
  readonly issued_at: string;
  readonly expires_at: string;
}

export interface TaskCheckContractEnvelope {
  readonly contract: TaskCheckContract;
  readonly signature: string;
}

const TASK_ID = /^[a-z][a-z0-9-]{1,47}$/;

const FIELDS: Readonly<Record<keyof TaskCheckContract, Check>> = {
  schema_version: (value) => value === TASK_CHECK_CONTRACT_SCHEMA_VERSION,
  kind: (value) => value === TASK_CHECK_CONTRACT_KIND,
  evaluation_task_id: text(UUID),
  tenant_id: text(UUID),
  project_id: text(UUID),
  repo: text(REPO),
  task_id: text(TASK_ID),
  card_commit: text(GIT_SHA),
  card_sha256: text(SHA256),
  base_sha: text(GIT_SHA),
  merge_sha: text(GIT_SHA),
  attempt: positiveInt,
  issued_at: timestamp,
  expires_at: timestamp,
};

/** The contract fields, in schema order. */
export const TASK_CHECK_CONTRACT_FIELDS = Object.keys(
  FIELDS,
) as readonly (keyof TaskCheckContract)[];

export type TaskCheckContractValidation =
  | { readonly ok: true; readonly contract: TaskCheckContract }
  | { readonly ok: false; readonly field: string };

/**
 * Checks a value against the task check contract schema: every field present in its format, no
 * other field, `expires_at` after `issued_at`, two different commits. Returns the first field that
 * fails.
 */
export function validateTaskCheckContract(value: unknown): TaskCheckContractValidation {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, field: '(contract)' };
  }
  const record = value as Record<string, unknown>;
  const extra = Object.keys(record).find((key) => !Object.hasOwn(FIELDS, key));
  if (extra !== undefined) return { ok: false, field: extra };
  for (const field of TASK_CHECK_CONTRACT_FIELDS) {
    if (!FIELDS[field](record[field])) return { ok: false, field };
  }
  if (Date.parse(record.expires_at as string) <= Date.parse(record.issued_at as string)) {
    return { ok: false, field: 'expires_at' };
  }
  if (record.base_sha === record.merge_sha) return { ok: false, field: 'merge_sha' };
  return { ok: true, contract: value as TaskCheckContract };
}

export interface ParsedTaskCheckContractEnvelope {
  readonly contract: TaskCheckContract;
  readonly signature: string;
  readonly keyVersion: number;
}

/**
 * Checks the shape of an envelope: exactly `contract` and `signature`, a valid contract and a
 * `vault:v<N>:…` signature. Undefined when anything is malformed. The signature is not verified.
 */
export function parseTaskCheckContractEnvelope(
  value: unknown,
): ParsedTaskCheckContractEnvelope | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== 'contract' || keys[1] !== 'signature') return undefined;
  const validation = validateTaskCheckContract(record.contract);
  const signature = record.signature;
  if (!validation.ok || typeof signature !== 'string' || signature.length > 512) return undefined;
  const match = SIGNATURE.exec(signature);
  if (!match) return undefined;
  return { contract: validation.contract, signature, keyVersion: Number(match[1]) };
}

// ---------- The handoff (worker → runner) ----------

export interface CheckEvaluationTaskInput {
  readonly tenantId: string;
  readonly evaluationTaskId: string;
  /** The card the check is for; the contract names it too. */
  readonly cardSha256: string;
  /** The attempt the contract was issued for. */
  readonly attempt: number;
  /** Single-use wrapping token around `{ token }`: a single-repository read token. */
  readonly wrappedGitToken: string;
}

/** Why a check failed (codes, ADR-M85 §2.5). */
export const TASK_CHECK_FAILURES = [
  /** The hidden tests pass without the change: they do not test it. */
  'passes_without_change',
  /** The reference solution does not apply, or a command fails with it. */
  'solution_fails',
  /** The repository could not be installed (pnpm only for now, QUESTIONS #489). */
  'install_failed',
  /** The card at its commit is not the registered one, or not valid. */
  'card_changed',
  /** The spec at its commit does not have the card's SHA-256. */
  'spec_changed',
  /** A hidden test file is missing at the merge commit. */
  'hidden_test_missing',
  /** The check was handed over too many times (lost runners, refused contracts). */
  'check_lost',
] as const;
export type TaskCheckFailure = (typeof TASK_CHECK_FAILURES)[number];

export type CheckEvaluationTaskResult =
  /** Both scorings agree with the card: the task can be reviewed. */
  | { readonly outcome: 'checked' }
  | { readonly outcome: 'check_failed'; readonly code: TaskCheckFailure }
  /** A real run needed the slot before the check started scoring: handed over again. */
  | { readonly outcome: 'preempted' }
  /** The runner did not start the check (a refused contract, a task not `checking`). */
  | { readonly outcome: 'refused'; readonly reason: string };

export interface EvaluationTaskCheckActivities {
  checkEvaluationTask(input: CheckEvaluationTaskInput): Promise<CheckEvaluationTaskResult>;
}

/** Workflow type of one task check on the worker (the exported workflow function). */
export const EVALUATION_TASK_CHECK_WORKFLOW_TYPE = 'evaluationTaskCheckWorkflow';

/**
 * Workflow ID of one check attempt: `evaluation-task-check/<tenant>/<task>/<card sha256>/<attempt>`.
 * A second start of the same attempt is refused by Temporal. Throws for malformed values.
 */
export function evaluationTaskCheckWorkflowId(ref: {
  readonly tenantId: string;
  readonly evaluationTaskId: string;
  readonly cardSha256: string;
  readonly attempt: number;
}): string {
  if (!UUID.test(ref.tenantId) || !UUID.test(ref.evaluationTaskId)) {
    throw new Error('evaluationTaskCheckWorkflowId: tenant and task IDs must be lowercase UUIDs');
  }
  if (!SHA256.test(ref.cardSha256)) {
    throw new Error('evaluationTaskCheckWorkflowId: the card SHA-256 must be lowercase hex');
  }
  if (!Number.isSafeInteger(ref.attempt) || ref.attempt < 1) {
    throw new Error('evaluationTaskCheckWorkflowId: the attempt must be a positive integer');
  }
  return `evaluation-task-check/${ref.tenantId}/${ref.evaluationTaskId}/${ref.cardSha256}/${String(ref.attempt)}`;
}

/** How the check workflow ends: the runner's outcome, or `lost` when the runner did not answer. */
export type EvaluationTaskCheckWorkflowResult = CheckEvaluationTaskResult['outcome'] | 'lost';

/** Starts and checks task check workflows (Temporal in the worker, a fake in tests). */
export interface EvaluationTaskCheckDispatcher {
  /** Starts the workflow of one attempt. A workflow that exists already is not an error. */
  start(input: CheckEvaluationTaskInput): Promise<void>;
  /** True while the workflow of this attempt runs. */
  isRunning(ref: {
    readonly tenantId: string;
    readonly evaluationTaskId: string;
    readonly cardSha256: string;
    readonly attempt: number;
  }): Promise<boolean>;
}
