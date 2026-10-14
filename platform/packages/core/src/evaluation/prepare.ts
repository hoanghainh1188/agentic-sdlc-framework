// Preparing an evaluation run for the runner (task L04, design/ADR-M81 §2.3, §2.4, §2.8). The
// worker's evaluation loop calls `prepareEvaluationRun` for a queued run; it is the evaluation
// counterpart of `prepareRun` (C06), with no intent and no gate. In order:
// 1. the evaluation must be open and its budget not used up (the used-up case stops it);
// 2. the configuration's model is checked again against the gateway's current list and the
//    project's policy for the evaluation's data class (a model removed since the start cancels
//    the run, `model_not_allowed`);
// 3. the contract is issued and signed (`issueEvaluationContract`);
// 4. the run's virtual key is issued, capped at what is left of the evaluation, the run and the
//    tenant budgets (`CostController.issueEvaluationRunKey`);
// 5. the single-repository read token is issued, and both secrets are wrapped as single-use
//    OpenBao wrapping tokens that live as long as the contract. Only the wrapping tokens and IDs
//    travel on: no secret, no client data in the Temporal history.
// If anything fails after the key exists, the key is revoked. The contract of a failed attempt
// stays; the run gets its next attempt from the loop (`listHandedOver`).
import {
  GitHostError,
  type GitHostAdapter,
  type ModelRef,
  type RunContractSigner,
  type SecretWrapper,
} from '@sdlc/contracts';

import { CostError } from '../cost/errors.js';
import type { CostController } from '../cost/controller.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { loadEffectiveConfig } from '../registry/effective-config.js';
import { projectRepoRef } from '../workflow/g4-proposal.js';
import { stopEvaluationIfBudgetUsed } from './budget.js';
import { EvaluationContractError, issueEvaluationContract } from './contract.js';
import type { EvaluationPolicyFactory } from './start.js';

/** Stop reasons written by this module (codes). */
export const MODEL_NOT_ALLOWED = 'model_not_allowed';
export const TENANT_BUDGET_USED = 'tenant_budget_used';

export interface PrepareEvaluationDeps {
  readonly signer: RunContractSigner;
  readonly costController: Pick<CostController, 'issueEvaluationRunKey' | 'endRunKey'>;
  readonly gitHost: Pick<GitHostAdapter, 'issueShortLivedToken'>;
  readonly wrapper: SecretWrapper;
  /** The gateway's current model list (QUESTIONS #17). */
  readonly models: () => Promise<readonly ModelRef[]>;
  readonly policyFactory: EvaluationPolicyFactory;
  /** Services the sandbox may reach, as `alias:port` (deployment settings). */
  readonly egressAllowlist: readonly string[];
  /** Default: `new Date()`. */
  readonly now?: () => Date;
}

export interface PreparedEvaluationRun {
  readonly tenantId: string;
  readonly evaluationRunId: string;
  readonly attempt: number;
  /** When the key was issued: the spend sync after the run starts here. */
  readonly keyIssuedAt: Date;
  readonly wrappedGitToken: string;
  readonly wrappedVirtualKey: string;
}

export type PrepareEvaluationRefusal =
  /** The run is not queued any more, or its evaluation ended. */
  | 'not_startable'
  /** The evaluation's budget is used up: the evaluation was stopped. */
  | 'budget_used'
  /** The tenant's budget of this month is used up: the evaluation was stopped. */
  | 'tenant_budget_used'
  /** The model is not allowed any more: the run was cancelled. */
  | 'model_not_allowed';

export type PrepareEvaluationResult =
  | { readonly ok: true; readonly run: PreparedEvaluationRun }
  | { readonly ok: false; readonly reason: PrepareEvaluationRefusal };

const SECONDS_PER_MINUTE = 60;

export async function prepareEvaluationRun(
  scope: TenantScope,
  deps: PrepareEvaluationDeps,
  evaluationRunId: string,
): Promise<PrepareEvaluationResult> {
  const run = await scope.evaluationRuns.getById(evaluationRunId);
  if (run?.status !== 'queued') return { ok: false, reason: 'not_startable' };
  const evaluation = await scope.evaluations.getById(run.evaluation_id);
  if (evaluation?.status !== 'queued' && evaluation?.status !== 'running') {
    return { ok: false, reason: 'not_startable' };
  }
  const project = await scope.projects.getById(evaluation.project_id);
  const ref = project ? projectRepoRef(project) : undefined;
  if (!project || !ref) throw new GitHostError('invalid_input', { field: 'repo' });

  if (await stopEvaluationIfBudgetUsed(scope, evaluation.id)) {
    return { ok: false, reason: 'budget_used' };
  }

  const { config } = await loadEffectiveConfig(scope.projectConfigs, evaluation.project_id);
  const policy = deps.policyFactory(config, await deps.models());
  if (!policy.allowedModels({ dataClass: evaluation.data_class }).includes(run.model)) {
    await scope.evaluationRuns.cancelOne(run.id, MODEL_NOT_ALLOWED);
    return { ok: false, reason: 'model_not_allowed' };
  }

  try {
    await issueEvaluationContract(
      scope,
      { evaluationRunId: run.id, egressAllowlist: deps.egressAllowlist },
      { signer: deps.signer, ...(deps.now ? { now: deps.now } : {}) },
    );
  } catch (error) {
    if (error instanceof EvaluationContractError && error.code === 'budget_used') {
      await stopEvaluationIfBudgetUsed(scope, evaluation.id);
      return { ok: false, reason: 'budget_used' };
    }
    if (error instanceof EvaluationContractError && error.code === 'run_not_queued') {
      return { ok: false, reason: 'not_startable' };
    }
    throw error;
  }

  const keyIssuedAt = deps.now ? deps.now() : new Date();
  let key;
  try {
    key = await deps.costController.issueEvaluationRunKey({
      tenantId: scope.tenantId,
      evaluationRunId: run.id,
    });
  } catch (error) {
    if (error instanceof CostError && error.code === 'intent_budget_exhausted') {
      await stopEvaluationIfBudgetUsed(scope, evaluation.id);
      return { ok: false, reason: 'budget_used' };
    }
    if (error instanceof CostError && error.code === 'tenant_budget_exhausted') {
      await scope.transaction(async (tx) => {
        await tx.evaluationRuns.cancelWaiting(evaluation.id, TENANT_BUDGET_USED);
        await tx.evaluations.finish(evaluation.id, 'stopped_budget', TENANT_BUDGET_USED);
      });
      return { ok: false, reason: 'tenant_budget_used' };
    }
    throw error;
  }

  try {
    const token = await deps.gitHost.issueShortLivedToken(ref, {
      permissions: { contents: 'read' },
    });
    const ttlSeconds = config.run.contract_validity_minutes * SECONDS_PER_MINUTE;
    const wrappedGitToken = await deps.wrapper.wrap({ token: token.token }, { ttlSeconds });
    const wrappedVirtualKey = await deps.wrapper.wrap({ key: key.key.key }, { ttlSeconds });
    return {
      ok: true,
      run: {
        tenantId: scope.tenantId,
        evaluationRunId: run.id,
        attempt: run.attempt,
        keyIssuedAt,
        wrappedGitToken: wrappedGitToken.reveal(),
        wrappedVirtualKey: wrappedVirtualKey.reveal(),
      },
    };
  } catch (error) {
    await deps.costController.endRunKey({ runId: run.id, syncFrom: keyIssuedAt });
    throw error;
  }
}
