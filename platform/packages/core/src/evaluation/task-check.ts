// The check of a project's evaluation task (task L07, design/ADR-M85 §2.5, QUESTIONS #488).
//
// - `prepareTaskCheck` (worker): for a `registered` task, reads the card on the default branch.
//   A removed card makes the task `gone`; a card that changed since it was registered fails the
//   check (`card_changed`: the person registers it again). Otherwise the task becomes `checking`,
//   the contract of this attempt is signed and stored, and a single-repository read token is
//   wrapped for the runner. Only IDs, a hash and the wrapping token travel on.
// - `verifyTaskCheckContract` (runner): the signature, the stored copy, the time window, and the
//   task still `checking` on the same card and attempt.
// - `finishTaskCheck` (worker): writes the runner's answer. `checked` and `check_failed` end the
//   check; a check that did not end goes back to `registered` and is handed over again, at most
//   `MAX_TASK_CHECK_ATTEMPTS` times (then `check_lost`).
// A Git host that cannot be read throws: the loop tries again on its next pass.
import { createHash } from 'node:crypto';

import { canonicalJson } from '@sdlc/config';
import {
  GitHostError,
  parseTaskCheckContractEnvelope,
  signatureKeyVersion,
  TASK_CHECK_CONTRACT_KIND,
  TASK_CHECK_CONTRACT_SCHEMA_VERSION,
  validateTaskCheckContract,
  type CheckEvaluationTaskInput,
  type CheckEvaluationTaskResult,
  type GitHostAdapter,
  type RunContractRejectReason,
  type RunContractSigner,
  type RunContractVerifier,
  type SecretWrapper,
  type TaskCheckContract,
} from '@sdlc/contracts';

import type { PlatformDatabase } from '../db/platform-database.js';
import type { EvaluationTask } from '../db/schema.js';
import { parseTenantId } from '../db/tenant-id.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { loadEffectiveConfig } from '../registry/effective-config.js';
import { projectRepoRef } from '../workflow/g4-proposal.js';

/** Hand-overs of one card's check before it fails with `check_lost`. */
export const MAX_TASK_CHECK_ATTEMPTS = 3;

const SECONDS_PER_MINUTE = 60;

export interface TaskCheckDeps {
  readonly signer: RunContractSigner;
  readonly gitHost: Pick<
    GitHostAdapter,
    'getBranchHead' | 'getFileAtCommit' | 'issueShortLivedToken'
  >;
  readonly wrapper: SecretWrapper;
  /** Default: `new Date()`. */
  readonly now?: () => Date;
}

export type PrepareTaskCheckResult =
  | { readonly ok: true; readonly input: CheckEvaluationTaskInput }
  | {
      readonly ok: false;
      /** `not_startable` (not `registered`), `gone`, `card_changed`, `check_lost`. */
      readonly reason: 'not_startable' | 'gone' | 'card_changed' | 'check_lost';
    };

/** The exact bytes that are signed and hashed. */
export function taskCheckContractBytes(contract: TaskCheckContract): Uint8Array {
  return new Uint8Array(Buffer.from(canonicalJson(contract), 'utf8'));
}

export function taskCheckContractSha256(contract: TaskCheckContract): string {
  return createHash('sha256').update(taskCheckContractBytes(contract)).digest('hex');
}

/** True when the Git host answered that the file does not exist. */
function notFound(error: unknown): boolean {
  return error instanceof GitHostError && error.code === 'not_found';
}

/**
 * Prepares the check of one registered task for the runner (ADR-M85 §2.5). Throws when the Git
 * host, OpenBao or the signer cannot be reached; a task taken to `checking` goes back to
 * `registered` first.
 */
export async function prepareTaskCheck(
  scope: TenantScope,
  deps: TaskCheckDeps,
  evaluationTaskId: string,
): Promise<PrepareTaskCheckResult> {
  const task = await scope.evaluationTasks.getById(evaluationTaskId);
  if (task?.status !== 'registered') return { ok: false, reason: 'not_startable' };
  const project = await scope.projects.getById(task.project_id);
  const ref = project ? projectRepoRef(project) : undefined;
  if (!project || !ref) throw new GitHostError('invalid_input', { field: 'repo' });

  if (task.check_attempt >= MAX_TASK_CHECK_ATTEMPTS) {
    await scope.evaluationTasks.recordCheck(task.id, task.card_sha256, {
      status: 'check_failed',
      code: 'check_lost',
    });
    return { ok: false, reason: 'check_lost' };
  }

  // The card must still be on the default branch, as it was registered (ADR-M85 §2.8).
  const head = await deps.gitHost.getBranchHead(ref, project.default_branch);
  let text: string;
  try {
    text = await deps.gitHost.getFileAtCommit(ref, task.card_path, head);
  } catch (error) {
    if (!notFound(error)) throw error;
    await scope.evaluationTasks.markGone(task.id);
    return { ok: false, reason: 'gone' };
  }
  if (createHash('sha256').update(text, 'utf8').digest('hex') !== task.card_sha256) {
    await scope.evaluationTasks.recordCheck(task.id, task.card_sha256, {
      status: 'check_failed',
      code: 'card_changed',
    });
    return { ok: false, reason: 'card_changed' };
  }

  const started = await scope.evaluationTasks.startCheck(task.id, task.card_sha256);
  if (!started) return { ok: false, reason: 'not_startable' };
  try {
    const { config } = await loadEffectiveConfig(scope.projectConfigs, project.id);
    const ttlSeconds = config.run.contract_validity_minutes * SECONDS_PER_MINUTE;
    await issueTaskCheckContract(scope, deps, started, project.repo_full_name, ttlSeconds);
    const token = await deps.gitHost.issueShortLivedToken(ref, {
      permissions: { contents: 'read' },
    });
    const wrapped = await deps.wrapper.wrap({ token: token.token }, { ttlSeconds });
    return {
      ok: true,
      input: {
        tenantId: scope.tenantId,
        evaluationTaskId: started.id,
        cardSha256: started.card_sha256,
        attempt: started.check_attempt,
        wrappedGitToken: wrapped.reveal(),
      },
    };
  } catch (error) {
    await scope.evaluationTasks.requeueCheck(started.id, started.card_sha256);
    throw error;
  }
}

async function issueTaskCheckContract(
  scope: TenantScope,
  deps: Pick<TaskCheckDeps, 'signer' | 'now'>,
  task: EvaluationTask,
  repo: string,
  ttlSeconds: number,
): Promise<void> {
  const issuedAt = deps.now ? deps.now() : new Date();
  const draft: TaskCheckContract = {
    schema_version: TASK_CHECK_CONTRACT_SCHEMA_VERSION,
    kind: TASK_CHECK_CONTRACT_KIND,
    evaluation_task_id: task.id,
    tenant_id: scope.tenantId,
    project_id: task.project_id,
    repo,
    task_id: task.task_id,
    card_commit: task.card_commit,
    card_sha256: task.card_sha256,
    base_sha: task.base_commit,
    merge_sha: task.merge_commit,
    attempt: task.check_attempt,
    issued_at: issuedAt.toISOString(),
    expires_at: new Date(issuedAt.getTime() + ttlSeconds * 1000).toISOString(),
  };
  const validation = validateTaskCheckContract(draft);
  if (!validation.ok) {
    throw new Error(`task check contract: field ${validation.field} does not fit the schema`);
  }
  const contract = validation.contract;
  const signed = await deps.signer.sign(taskCheckContractBytes(contract));
  if (signatureKeyVersion(signed.signature) !== signed.keyVersion) {
    throw new Error('task check contract: the signer returned an inconsistent signature');
  }
  await scope.evaluationTaskCheckContracts.store({
    contract,
    contractSha256: taskCheckContractSha256(contract),
    signature: signed.signature,
    keyVersion: signed.keyVersion,
  });
}

export interface VerifyTaskCheckDeps {
  readonly verifier: RunContractVerifier;
  /** Default: `new Date()`. */
  readonly now?: () => Date;
}

export type TaskCheckContractVerification =
  | { readonly ok: true; readonly contract: TaskCheckContract; readonly task: EvaluationTask }
  | { readonly ok: false; readonly reason: RunContractRejectReason };

/**
 * Checks a task check contract on the runner. Never throws for a bad contract: it returns a
 * reject reason (the Run Contract's codes). Throws only when the database or OpenBao is down.
 */
export async function verifyTaskCheckContract(
  db: PlatformDatabase,
  envelope: unknown,
  deps: VerifyTaskCheckDeps,
): Promise<TaskCheckContractVerification> {
  const parsed = parseTaskCheckContractEnvelope(envelope);
  if (!parsed) return { ok: false, reason: 'malformed' };
  const { contract, signature, keyVersion } = parsed;
  if (!(await deps.verifier.verify(taskCheckContractBytes(contract), signature))) {
    return { ok: false, reason: 'bad_signature' };
  }
  const scope = db.forTenant(parseTenantId(contract.tenant_id));
  const stored = await scope.evaluationTaskCheckContracts.get(
    contract.evaluation_task_id,
    contract.card_sha256,
    contract.attempt,
  );
  if (!stored) return { ok: false, reason: 'unknown_contract' };
  if (
    stored.contract_sha256 !== taskCheckContractSha256(contract) ||
    stored.signature !== signature ||
    stored.key_version !== keyVersion
  ) {
    return { ok: false, reason: 'mismatch' };
  }
  const { config } = await loadEffectiveConfig(scope.projectConfigs, contract.project_id);
  const now = (deps.now ? deps.now() : new Date()).getTime();
  const skewMs = config.run.contract_clock_skew_seconds * 1000;
  if (now < Date.parse(contract.issued_at) - skewMs) return { ok: false, reason: 'not_yet_valid' };
  // Expiry has no tolerance (ADR-M22 section 2.4).
  if (now >= Date.parse(contract.expires_at)) return { ok: false, reason: 'expired' };
  const task = await scope.evaluationTasks.getById(contract.evaluation_task_id);
  if (
    task?.status !== 'checking' ||
    task.card_sha256 !== contract.card_sha256 ||
    task.check_attempt !== contract.attempt
  ) {
    return { ok: false, reason: 'run_not_startable' };
  }
  return { ok: true, contract, task };
}

export interface FinishTaskCheckInput {
  readonly evaluationTaskId: string;
  readonly cardSha256: string;
  readonly attempt: number;
  /** The runner's answer, or `lost` when it did not answer (heartbeat timeout, failure). */
  readonly end: CheckEvaluationTaskResult | { readonly outcome: 'lost' };
}

/**
 * Writes the end of one check attempt. Idempotent: an attempt that is not the task's current one,
 * or a task no longer `checking`, changes nothing.
 */
export async function finishTaskCheck(
  scope: TenantScope,
  input: FinishTaskCheckInput,
): Promise<void> {
  const task = await scope.evaluationTasks.getById(input.evaluationTaskId);
  if (
    task?.status !== 'checking' ||
    task.card_sha256 !== input.cardSha256 ||
    task.check_attempt !== input.attempt
  ) {
    return;
  }
  const end = input.end;
  if (end.outcome === 'checked') {
    await scope.evaluationTasks.recordCheck(task.id, task.card_sha256, { status: 'checked' });
  } else if (end.outcome === 'check_failed') {
    await scope.evaluationTasks.recordCheck(task.id, task.card_sha256, {
      status: 'check_failed',
      code: end.code,
    });
  } else {
    // Preempted, refused or lost: handed over again by the loop (at most MAX_TASK_CHECK_ATTEMPTS).
    await scope.evaluationTasks.requeueCheck(task.id, task.card_sha256);
  }
}
