// The contract of an evaluation run: issue (worker side) and verify (runner side) (task L04, design/
// ADR-M81 §2.2, QUESTIONS #460). A second kind of Run Contract: the same Transit key and the same
// signed form (RFC 8785 canonical JSON), its own schema (`@sdlc/contracts`), stored per attempt in
// `evaluation_run_contracts`. No intent and no plan: the contract names the evaluation run, the
// project's repository and the commit the run starts from, the task set (a numbered `folder` set,
// or the project's task cards at a commit, L07), the one model of the configuration and the caps.
//
// The cap is what is left of the evaluation's budget (ADR-M81 §2.4); an evaluation whose budget is
// used up gets no contract. The runner checks the signature first, then the stored contract, the
// time window and the run (`queued`, on the contract's attempt), like `verifyRunContract`.
import { createHash } from 'node:crypto';

import { canonicalJson } from '@sdlc/config';
import {
  EVALUATION_CONTRACT_KIND,
  EVALUATION_CONTRACT_SCHEMA_VERSION,
  parseEvaluationContractEnvelope,
  signatureKeyVersion,
  validateEvaluationContract,
  type EvaluationContractEnvelope,
  type EvaluationRunContract,
  type RunContractRejectReason,
  type RunContractSigner,
  type RunContractVerifier,
} from '@sdlc/contracts';

import type { PlatformDatabase } from '../db/platform-database.js';
import type { EvaluationRun } from '../db/schema.js';
import { parseTenantId } from '../db/tenant-id.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { loadEffectiveConfig } from '../registry/effective-config.js';
import { sortedUnique } from '../run-contract/issue.js';
import { evaluationBudget } from './budget.js';

export const EVALUATION_CONTRACT_ERROR_CODES = [
  'run_not_found',
  'run_not_queued',
  'evaluation_closed',
  'budget_used',
  'base_sha_missing',
  'project_not_found',
  'invalid_input',
  'signature_invalid',
] as const;
export type EvaluationContractErrorCode = (typeof EVALUATION_CONTRACT_ERROR_CODES)[number];

export class EvaluationContractError extends Error {
  override readonly name = 'EvaluationContractError';

  constructor(
    readonly code: EvaluationContractErrorCode,
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

/** The exact bytes that are signed and hashed. */
export function evaluationContractBytes(contract: EvaluationRunContract): Uint8Array {
  return new Uint8Array(Buffer.from(canonicalJson(contract), 'utf8'));
}

/** `contract_sha256`: SHA-256 of the canonical bytes, lowercase hex. */
export function evaluationContractSha256(contract: EvaluationRunContract): string {
  return createHash('sha256').update(evaluationContractBytes(contract)).digest('hex');
}

export interface IssueEvaluationContract {
  readonly evaluationRunId: string;
  /** Hosts the sandbox may reach: LiteLLM and the package proxy (deployment settings). */
  readonly egressAllowlist: readonly string[];
}

export interface IssueEvaluationDeps {
  readonly signer: RunContractSigner;
  /** Default: `new Date()`. */
  readonly now?: () => Date;
}

export interface IssuedEvaluationContract {
  readonly envelope: EvaluationContractEnvelope;
  readonly contractSha256: string;
  readonly keyVersion: number;
}

/**
 * Builds, signs and stores the contract of a `queued` run for its current attempt. Throws
 * `EvaluationContractError` when the run is not queued, its evaluation is closed or has no budget
 * left, or a field does not fit the schema.
 */
export async function issueEvaluationContract(
  scope: TenantScope,
  input: IssueEvaluationContract,
  deps: IssueEvaluationDeps,
): Promise<IssuedEvaluationContract> {
  const run = await scope.evaluationRuns.getById(input.evaluationRunId);
  if (!run) {
    throw new EvaluationContractError('run_not_found', `evaluation run ${input.evaluationRunId}`);
  }
  if (run.status !== 'queued') {
    throw new EvaluationContractError('run_not_queued', `evaluation run is ${run.status}`);
  }
  const evaluation = await scope.evaluations.getById(run.evaluation_id);
  if (evaluation?.status !== 'queued' && evaluation?.status !== 'running') {
    throw new EvaluationContractError('evaluation_closed', 'the evaluation is not open');
  }
  // A `folder` set's runs start at the evaluation's commit; a project task's run at its own (L07).
  const baseSha = run.base_sha ?? evaluation.base_sha;
  if (baseSha === null) {
    throw new EvaluationContractError('base_sha_missing', 'the run has no base commit');
  }
  const project = await scope.projects.getById(evaluation.project_id);
  if (!project) {
    throw new EvaluationContractError('project_not_found', `project ${evaluation.project_id}`);
  }
  const budget = await evaluationBudget(scope, evaluation);
  if (budget.used) {
    throw new EvaluationContractError('budget_used', 'the budget of the evaluation is used up');
  }
  const { config } = await loadEffectiveConfig(scope.projectConfigs, evaluation.project_id);

  const issuedAt = deps.now ? deps.now() : new Date();
  const expiresAt = new Date(issuedAt.getTime() + config.run.contract_validity_minutes * 60_000);
  const draft: EvaluationRunContract = {
    schema_version: EVALUATION_CONTRACT_SCHEMA_VERSION,
    kind: EVALUATION_CONTRACT_KIND,
    evaluation_run_id: run.id,
    evaluation_id: evaluation.id,
    evaluation_code: evaluation.code,
    tenant_id: scope.tenantId,
    project_id: evaluation.project_id,
    repo: project.repo_full_name,
    base_sha: baseSha,
    configuration_id: run.configuration_id,
    task_id: run.task_id,
    task_set_kind: evaluation.task_set_kind,
    task_set_version: evaluation.task_set_version,
    task_set_commit: evaluation.task_set_commit,
    run_index: run.run_index,
    attempt: run.attempt,
    agent_version: run.agent_version,
    model: run.model,
    max_budget_usd: budget.remainingUsd,
    max_iterations: run.max_iterations,
    max_duration_min: run.max_duration_min,
    loop_threshold: config.run.loop_detection.identical_tool_calls_max,
    allowed_models: [run.model],
    egress_allowlist: sortedUnique(input.egressAllowlist),
    issued_at: issuedAt.toISOString(),
    expires_at: expiresAt.toISOString(),
  };
  const validation = validateEvaluationContract(draft);
  if (!validation.ok) {
    throw new EvaluationContractError(
      'invalid_input',
      `field ${validation.field} does not fit the evaluation contract schema`,
      validation.field,
    );
  }
  const contract = validation.contract;
  const signed = await deps.signer.sign(evaluationContractBytes(contract));
  if (signatureKeyVersion(signed.signature) !== signed.keyVersion) {
    throw new EvaluationContractError(
      'signature_invalid',
      'the signer returned an inconsistent signature',
    );
  }
  const contractSha256 = evaluationContractSha256(contract);
  await scope.evaluationContracts.store({
    contract,
    contractSha256,
    signature: signed.signature,
    keyVersion: signed.keyVersion,
  });
  return {
    envelope: { contract, signature: signed.signature },
    contractSha256,
    keyVersion: signed.keyVersion,
  };
}

export interface VerifyEvaluationDeps {
  readonly verifier: RunContractVerifier;
  /** Default: `new Date()`. */
  readonly now?: () => Date;
}

export type EvaluationContractVerification =
  | {
      readonly ok: true;
      readonly contract: EvaluationRunContract;
      readonly run: EvaluationRun;
    }
  | { readonly ok: false; readonly reason: RunContractRejectReason };

/**
 * Checks a contract envelope received from the worker. Never throws for a bad contract: it returns
 * a reject reason (the same codes as the Run Contract). Throws only when the check itself cannot
 * run (database or OpenBao down). An evaluation run has no run events, so a rejection is returned
 * to the caller (the activity), which logs the code.
 */
export async function verifyEvaluationContract(
  db: PlatformDatabase,
  envelope: unknown,
  deps: VerifyEvaluationDeps,
): Promise<EvaluationContractVerification> {
  const parsed = parseEvaluationContractEnvelope(envelope);
  if (!parsed) return { ok: false, reason: 'malformed' };
  const { contract, signature, keyVersion } = parsed;
  if (!(await deps.verifier.verify(evaluationContractBytes(contract), signature))) {
    return { ok: false, reason: 'bad_signature' };
  }
  const scope = db.forTenant(parseTenantId(contract.tenant_id));
  const stored = await scope.evaluationContracts.getForAttempt(
    contract.evaluation_run_id,
    contract.attempt,
  );
  if (!stored) return { ok: false, reason: 'unknown_contract' };
  if (
    stored.contract_sha256 !== evaluationContractSha256(contract) ||
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
  if (stored.revoked_at !== null) return { ok: false, reason: 'revoked' };
  const run = await scope.evaluationRuns.getById(contract.evaluation_run_id);
  if (run?.status !== 'queued' || run.attempt !== contract.attempt) {
    return { ok: false, reason: 'run_not_startable' };
  }
  return { ok: true, contract, run };
}
