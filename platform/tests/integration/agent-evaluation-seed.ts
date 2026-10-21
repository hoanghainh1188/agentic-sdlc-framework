// Shared set-up of the agent register's evaluation tests (L09, L10; ADR-M86): a tenant whose
// project `shop` runs the agent `coder` (proposed, version 1.0.0, Person A as owner, Person B),
// plans of the project's whole numbered task set, and scored evaluations.
import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';
import { loadProjectConfig } from '@sdlc/config';
import type { ModelRef } from '@sdlc/contracts';

import { approveAgent } from '../../packages/core/src/agents/approvals.js';
import { AgentRegisterError } from '../../packages/core/src/agents/errors.js';
import type { NewEvaluationRunResult } from '../../packages/core/src/db/repositories/evaluation-runs.js';
import type { Agent, Evaluation } from '../../packages/core/src/db/schema.js';
import {
  createEvaluationPlan,
  startEvaluationPlan,
  type EvaluationPlanDeps,
  type PlanConfigurationInput,
} from '../../packages/core/src/evaluation/index.js';
import { EVAL_BASE_SHA } from './evaluation-seed.js';
import { seedPlanWorld, type PlanWorld } from './plan-seed.js';
import type { TestDatabase } from './db/helpers.js';

export const NOW = new Date('2026-10-21T08:00:00.000Z');
export const TASKS = ['t-a', 't-b', 't-c', 't-d', 't-e', 't-f', 't-g', 't-h'];
export const OLD_SHA = 'e'.repeat(64);
export const NEW_SHA = 'f'.repeat(64);
export const MODELS: ModelRef[] = [
  { model: 'gpt-oss-20b', providerType: 'self_hosted' },
  { model: 'qwen3-8b', providerType: 'self_hosted' },
];
export const RESULT: NewEvaluationRunResult = {
  instructions_sha256: OLD_SHA,
  outcome: 'finished',
  status: 'succeeded',
  stop_reason: null,
  applied: true,
  resolved: true,
  fail_to_pass_passed: true,
  pass_to_pass_passed: true,
  ci_passed: true,
  scope_breach: false,
  out_of_plan_files: 0,
  lint_findings: 0,
  diff_files: 2,
  diff_lines_added: 20,
  diff_lines_removed: 3,
  seconds: 90,
  iterations: 7,
  model_calls: 7,
  input_tokens: 1000,
  output_tokens: 200,
  cached_input_tokens: 0,
  cost_usd: '0.010000',
  hardware: {
    cpu_model: 'test',
    cpu_cores: 4,
    memory_gb: 8,
    docker_version: '29.0.0',
    gpu: null,
    runner_instance: 'runner-1',
  },
};

/** The agent configuration by its key, and the next version as a model. */
export const BY_KEY: PlanConfigurationInput = {
  id: 'current',
  agentKey: 'coder',
  maxIterations: 30,
  maxDurationMin: 20,
};
export const NEXT: PlanConfigurationInput = {
  id: 'next',
  model: 'gpt-oss-20b',
  providerType: 'self_hosted',
  maxIterations: 30,
  maxDurationMin: 20,
};

export interface World extends PlanWorld {
  readonly personB: string;
  readonly otherProjectId: string;
}

/** What one configuration scored: resolved tasks (or all), scope breaches, instructions. */
export interface Scores {
  readonly resolved?: (task: string) => boolean;
  readonly breach?: (task: string) => boolean;
  readonly instructions?: string;
}

/** The helpers, bound to a test database (`db()` is read when a helper runs). */
export function agentEvaluationHelpers(db: () => TestDatabase, prefix: string) {
  let tenants = 0;
  const deps = (): EvaluationPlanDeps => ({
    policyFactory: (config, list) => createSimplePolicyEngine({ config, models: list }),
    models: () => Promise.resolve(MODELS),
    taskSet: (version) =>
      Promise.resolve(
        version === 1 ? { version: 1, baseSha: EVAL_BASE_SHA, taskIds: TASKS } : undefined,
      ),
    gitHost: {
      getBranchHead: () => Promise.reject(new Error('no Git read in this test')),
      getFileAtCommit: () => Promise.reject(new Error('no Git read in this test')),
    },
    now: () => NOW,
  });

  async function configure(w: PlanWorld, projectId: string, yaml: string): Promise<void> {
    const loaded = loadProjectConfig(yaml);
    if (!loaded.ok) throw new Error('test configuration refused');
    const stored = await w.scope.projectConfigs.get(projectId);
    await w.scope.projectConfigs.save(projectId, {
      configYaml: yaml,
      configHash: loaded.configHash,
      updatedBy: null,
      expectedVersion: stored?.version ?? 0,
    });
  }

  const evaluationYaml = (body: string) =>
    `run:\n  agent_key: coder\nagents:\n  evaluation:\n${body || '    mode: warn\n'}`;

  /** A tenant with the project `shop` that runs the agent `coder` (proposed, version 1.0.0). */
  async function world(evaluation = ''): Promise<World> {
    const w = await seedPlanWorld(db().app, `${prefix}-${String(++tenants)}`, NOW);
    const b = await w.scope.users.create({ display_name: 'bea', email: `bea@${w.slug}.test` });
    await w.scope.roleBindings.grant({ user_id: b.id, project_id: w.projectId, role: 'person_b' });
    await w.scope.agents.create({
      agentKey: 'coder',
      version: '1.0.0',
      ownerId: w.users.a,
      modelRef: 'qwen3-8b',
      instructionsRef: 'AGENTS.md@v1',
      instructionsSha256: OLD_SHA,
      allowedTools: ['file_editor', 'terminal'],
      maxAutonomy: 'L2',
      approvedEnvironments: ['sandbox'],
    });
    await configure(w, w.projectId, evaluationYaml(evaluation));
    const other = await w.scope.projects.create({
      slug: 'other',
      name: 'Other',
      git_provider: 'github',
      repo_full_name: 'org/other',
    });
    return { ...w, personB: b.id, otherProjectId: other.id };
  }

  const agentOf = async (w: PlanWorld): Promise<Agent> => (await w.scope.agents.getByKey('coder'))!;

  /** Runs a plan of the project's whole numbered task set and scores it; `finish: false` leaves it open. */
  async function evaluate(
    w: PlanWorld,
    scores: Readonly<Record<string, Scores>>,
    options: {
      configurations?: readonly PlanConfigurationInput[];
      taskIds?: readonly string[] | null;
      finish?: boolean;
    } = {},
  ): Promise<Evaluation> {
    const plan = await createEvaluationPlan(w.scope, deps(), {
      projectId: w.projectId,
      code: `plan-${String(Math.random()).slice(2, 10)}`,
      content: {
        dataClass: 'internal',
        taskSetVersion: 1,
        taskIds: options.taskIds ?? null,
        runsPerTask: 1,
        budgetPerRunUsd: '2',
        monthlyCapUsd: '5',
        trigger: 'once',
        configurations: options.configurations ?? [BY_KEY],
      },
      userId: w.users.a,
    });
    const evaluation = await startEvaluationPlan(w.scope, deps(), {
      planId: plan.id,
      actor: { type: 'human', userId: w.users.a },
    });
    for (;;) {
      const claimed = await w.scope.evaluationRuns.claimQueued(50, 'runner-1');
      if (claimed.length === 0) break;
      for (const run of claimed) {
        const score = scores[run.configuration_id] ?? {};
        const resolved = score.resolved?.(run.task_id) ?? true;
        await w.scope.evaluationRuns.recordResult(run.id, {
          ...RESULT,
          instructions_sha256: score.instructions ?? OLD_SHA,
          resolved,
          fail_to_pass_passed: resolved,
          scope_breach: score.breach?.(run.task_id) ?? false,
        });
      }
    }
    if (options.finish === false) return evaluation;
    await w.scope.evaluations.finish(evaluation.id, 'completed', null);
    return (await w.scope.evaluations.getById(evaluation.id))!;
  }

  const approve = (
    w: World,
    as: 'owner' | 'person_b',
    evaluationCode?: string,
    now: Date = new Date(),
  ) =>
    approveAgent(
      w.scope,
      { type: 'human', userId: as === 'owner' ? w.users.a : w.personB },
      'coder',
      {
        purpose: 'activate',
        capacity: as,
        now,
        ...(evaluationCode === undefined ? {} : { evaluationCode }),
      },
    );

  async function refusal(promise: Promise<unknown>): Promise<AgentRegisterError> {
    try {
      await promise;
    } catch (error) {
      if (error instanceof AgentRegisterError) return error;
      throw error;
    }
    throw new Error('expected a refusal');
  }

  return { deps, configure, evaluationYaml, world, agentOf, evaluate, approve, refusal };
}
