// Starting an evaluation on the server (task L04, design/ADR-M81 §2.6, §2.7; QUESTIONS #464).
//
// An evaluation belongs to a project and has a data class. The same rules as for an intent apply
// (D-02 FR-19, D-07 §4), checked here before anything is written:
// - `prohibited` is refused;
// - the project's AI record must allow the data class (`aiRecordRefusal`);
// - every configuration's model must be allowed for the data class by the project's policy
//   (`allowedModels`), and `client_restricted` data goes to self-hosted models only, whatever the
//   project configuration says;
// - a model a configuration names is checked again when a run is issued (PR 4), against the
//   gateway's list.
// The platform never raises a data class (ADR-M32): the caller names it, the record decides.
import type { DataClass, ModelRef, PolicyEngine, ValidatedProjectConfig } from '@sdlc/contracts';

import { aiRecordRefusal, loadAiRecordFacts } from '../ai-record/index.js';
import { DbError } from '../db/errors.js';
import type { EvaluationConfigurationInput } from '../db/repositories/evaluations.js';
import type { Evaluation } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { loadEffectiveConfig } from '../registry/effective-config.js';
import { EvaluationError } from './errors.js';

/**
 * Builds a policy engine that knows the models of the evaluation's configurations. The apps pass
 * the adapter (`createSimplePolicyEngine({ config, models })`); core never imports adapters.
 */
export type EvaluationPolicyFactory = (
  config: ValidatedProjectConfig,
  models: readonly ModelRef[],
) => PolicyEngine;

export interface StartEvaluationInput {
  readonly projectId: string;
  readonly dataClass: DataClass;
  readonly taskSetVersion: number;
  readonly configName: string;
  readonly taskIds: readonly string[];
  readonly configurations: readonly EvaluationConfigurationInput[];
  readonly runsPerTask: number;
  /** USD, a decimal string, more than 0. */
  readonly budgetUsd: string;
  /** The operator command starts as the system; a person (L05) as themselves. */
  readonly startedBy: string | null;
  readonly now?: Date;
}

export interface StartEvaluationDeps {
  readonly policyFactory: EvaluationPolicyFactory;
}

/** Checks the rules above and writes the evaluation with its runs. */
export async function startEvaluation(
  scope: TenantScope,
  input: StartEvaluationInput,
  deps: StartEvaluationDeps,
): Promise<Evaluation> {
  if (input.dataClass === 'prohibited') {
    throw new EvaluationError('data_class_prohibited', 'prohibited data is never evaluated');
  }
  return scope.transaction(async (tx) => {
    const project = await tx.projects.getById(input.projectId);
    if (!project) {
      throw new EvaluationError('project_not_found', `project ${input.projectId} not found`);
    }
    if (project.status !== 'active') {
      throw new EvaluationError('project_not_active', `project ${input.projectId} is not active`);
    }
    const refusal = aiRecordRefusal(await loadAiRecordFacts(tx, input.projectId), input.dataClass);
    if (refusal !== null) {
      throw new EvaluationError(refusal, `the project does not allow ${input.dataClass}`);
    }
    if (input.dataClass === 'client_restricted') {
      const outside = input.configurations.find((c) => c.providerType !== 'self_hosted');
      if (outside) {
        throw new EvaluationError(
          'self_hosted_only',
          `configuration ${outside.id} is not self-hosted`,
        );
      }
    }
    const { config } = await loadEffectiveConfig(tx.projectConfigs, input.projectId);
    const policy = deps.policyFactory(
      config,
      input.configurations.map((c) => ({ model: c.model, providerType: c.providerType })),
    );
    const allowed = new Set(policy.allowedModels({ dataClass: input.dataClass }));
    const refused = input.configurations.find((c) => !allowed.has(c.model));
    if (refused) {
      throw new EvaluationError('model_not_allowed', `the model of ${refused.id} is not allowed`);
    }
    try {
      return await tx.evaluations.create(input);
    } catch (error) {
      if (error instanceof DbError && error.code === 'invalid_value') {
        throw new EvaluationError('invalid_input', error.message);
      }
      throw error;
    }
  });
}
