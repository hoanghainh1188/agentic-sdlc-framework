// D-08 L09 AC1 on PostgreSQL (design/ADR-M86 §2.1, §2.2; QUESTIONS #501, #503):
// - an evaluation of a plan records each configuration's source (`agent` or `model`), the agent's
//   own tools (sorted) and their SHA-256, and how many tasks of the project were approved (with
//   approved tasks: evaluation-project-task-set.test.ts);
// - a plan may evaluate a `proposed` or `suspended` agent, never a `quarantined` or `retired` one;
//   `on_change` sees the version of a suspended agent;
// - a real run still needs an `active` agent;
// - the new columns are fixed: `evaluation_configurations` and `agent_approvals` stay
//   append-only, `approved_tasks_at_start` never changes.
import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';
import type { AgentStatus, ModelRef } from '@sdlc/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { checkAgentForRun, toolsSha256 } from '../../../packages/core/src/agents/index.js';
import { AgentRegisterError } from '../../../packages/core/src/agents/errors.js';
import { DbError } from '../../../packages/core/src/db/errors.js';
import {
  createEvaluationPlan,
  EvaluationError,
  planFleetSha256,
  startEvaluationPlan,
  type EvaluationPlanDeps,
  type PlanContentInput,
} from '../../../packages/core/src/evaluation/index.js';
import { EVAL_BASE_SHA } from '../evaluation-seed.js';
import { seedPlanWorld, type PlanWorld } from '../plan-seed.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

const NOW = new Date('2026-10-20T08:00:00.000Z');
const MODELS: ModelRef[] = [
  { model: 'gpt-oss-20b', providerType: 'self_hosted' },
  { model: 'qwen3-8b', providerType: 'self_hosted' },
];

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    if (
      error instanceof EvaluationError ||
      error instanceof DbError ||
      error instanceof AgentRegisterError
    ) {
      return error.code;
    }
    throw error;
  }
}

describeDb('L09 AC1: the fingerprint of an evaluation configuration on PostgreSQL', () => {
  let t: TestDatabase;
  let tenants = 0;
  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  });

  const deps = (): EvaluationPlanDeps => ({
    policyFactory: (config, list) => createSimplePolicyEngine({ config, models: list }),
    models: () => Promise.resolve(MODELS),
    taskSet: (version) =>
      Promise.resolve(
        version === 1
          ? { version: 1, baseSha: EVAL_BASE_SHA, taskIds: ['feat-tax', 'bug-stock'] }
          : undefined,
      ),
    gitHost: {
      getBranchHead: () => Promise.reject(new Error('no Git read in this test')),
      getFileAtCommit: () => Promise.reject(new Error('no Git read in this test')),
    },
    now: () => NOW,
  });

  const world = (): Promise<PlanWorld> =>
    seedPlanWorld(t.app, `fingerprints-${String(++tenants)}`, NOW);

  const content = (over: Partial<PlanContentInput> = {}): PlanContentInput => ({
    dataClass: 'internal',
    taskSetVersion: 1,
    taskIds: null,
    runsPerTask: 1,
    budgetPerRunUsd: '2',
    monthlyCapUsd: '5',
    trigger: 'once',
    configurations: [
      { id: 'reg-qwen', agentKey: 'openhands-qwen', maxIterations: 30, maxDurationMin: 20 },
      {
        id: 'oss',
        model: 'gpt-oss-20b',
        providerType: 'self_hosted',
        maxIterations: 30,
        maxDurationMin: 20,
      },
    ],
    ...over,
  });

  const create = (w: PlanWorld, code = 'next-version', over: Partial<PlanContentInput> = {}) =>
    createEvaluationPlan(w.scope, deps(), {
      projectId: w.projectId,
      code,
      content: content(over),
      userId: w.users.a,
    });

  const start = (w: PlanWorld, planId: string) =>
    startEvaluationPlan(w.scope, deps(), { planId, actor: { type: 'human', userId: w.users.a } });

  async function setAgent(
    w: PlanWorld,
    key: string,
    change: { status?: AgentStatus; version?: string; allowedTools?: readonly string[] },
  ): Promise<string> {
    const agent = (await w.scope.agents.getByKey(key))!;
    await w.scope.agents.update(agent.id, change, NOW);
    return agent.id;
  }

  /** A `proposed` agent (a new version waiting for its first approval). */
  async function proposedAgent(w: PlanWorld, tools: readonly string[]): Promise<string> {
    const agent = await w.scope.agents.create({
      agentKey: 'openhands-next',
      version: '0.1.0',
      ownerId: w.users.a,
      modelRef: 'qwen3-8b',
      instructionsRef: 'AGENTS.md@v1',
      instructionsSha256: 'd'.repeat(64),
      allowedTools: tools,
      maxAutonomy: 'L2',
      approvedEnvironments: ['sandbox'],
    });
    return agent.id;
  }

  const nextConfiguration = {
    id: 'next',
    agentKey: 'openhands-next',
    maxIterations: 30,
    maxDurationMin: 20,
  };

  it('records the source, the sorted tools and their SHA-256, and no approved task', async () => {
    const w = await world();
    await proposedAgent(w, ['terminal', 'file_editor']);
    const plan = await create(w, 'next-version', {
      configurations: [...content().configurations, nextConfiguration],
    });
    const evaluation = await start(w, plan.id);
    expect(evaluation.approved_tasks_at_start).toBe(0);
    const configs = await w.scope.evaluations.configurations(evaluation.id);
    const all = ['file_editor', 'task_tracker', 'terminal'];
    expect(
      configs.map((c) => [c.configuration_id, c.source, c.allowed_tools, c.tools_sha256]),
    ).toEqual([
      ['next', 'agent', ['file_editor', 'terminal'], toolsSha256(['file_editor', 'terminal'])],
      // A model by name runs with the project's default agent and its tools.
      ['oss', 'model', all, toolsSha256(all)],
      ['reg-qwen', 'agent', all, toolsSha256(all)],
    ]);
    // The SHA-256 is of the sorted list as JSON: the order of the register does not count.
    expect(toolsSha256(['terminal', 'file_editor'])).toBe(toolsSha256(['file_editor', 'terminal']));
    expect(toolsSha256(['file_editor'])).not.toBe(toolsSha256(['file_editor', 'terminal']));
  });

  it('a plan evaluates a proposed agent; a real run of it is refused', async () => {
    const w = await world();
    const agentId = await proposedAgent(w, ['file_editor', 'terminal']);
    const evaluation = await start(
      w,
      (await create(w, 'next-version', { configurations: [nextConfiguration] })).id,
    );
    const [config] = await w.scope.evaluations.configurations(evaluation.id);
    expect(config).toMatchObject({ source: 'agent', agent_version: '0.1.0', model: 'qwen3-8b' });
    expect(await errorCode(runCheck(w, agentId))).toBe('agent_not_active');
  });

  it('a plan evaluates a suspended agent with its new version; a real run is refused', async () => {
    const w = await world();
    const agentId = await setAgent(w, 'openhands-qwen', { status: 'suspended' });
    await setAgent(w, 'openhands-qwen', { version: '1.1.0', allowedTools: ['terminal'] });
    const evaluation = await start(w, (await create(w)).id);
    const configs = await w.scope.evaluations.configurations(evaluation.id);
    expect(configs.find((c) => c.configuration_id === 'reg-qwen')).toMatchObject({
      source: 'agent',
      agent_version: '1.1.0',
      allowed_tools: ['terminal'],
      tools_sha256: toolsSha256(['terminal']),
    });
    expect(await errorCode(runCheck(w, agentId))).toBe('agent_not_active');
  });

  const runCheck = (w: PlanWorld, agentId: string) =>
    checkAgentForRun(w.scope, {
      agentId,
      projectId: w.projectId,
      autonomyLevel: 'L2',
      allowedModels: ['qwen3-8b'],
      instructionsSha256: 'd'.repeat(64),
    });

  it.each(['quarantined', 'retired'] as const)(
    'a plan never evaluates a %s agent',
    async (status) => {
      const w = await world();
      await setAgent(w, 'openhands-qwen', { status });
      expect(await errorCode(create(w))).toBe('agent_not_active');
    },
  );

  it('a plan saved before the agent was quarantined cannot start', async () => {
    const w = await world();
    const plan = await create(w);
    await setAgent(w, 'openhands-qwen', { status: 'quarantined' });
    expect(await errorCode(start(w, plan.id))).toBe('agent_not_active');
  });

  it('on_change sees the version of a suspended agent', async () => {
    const w = await world();
    const plan = await create(w);
    const { configurations } = (await w.scope.evaluationPlans.getVersion(plan.id, 1))!;
    const fleet = () =>
      planFleetSha256(w.scope, { models: deps().models! }, w.projectId, configurations);
    const before = await fleet();
    await setAgent(w, 'openhands-qwen', { status: 'suspended' });
    expect(await fleet()).toBe(before);
    await setAgent(w, 'openhands-qwen', { version: '1.1.0' });
    expect(await fleet()).not.toBe(before);
  });

  describe('the database', () => {
    it('keeps the configuration and the approved-task count fixed', async () => {
      const w = await world();
      const evaluation = await start(w, (await create(w)).id);
      await expect(
        sql`UPDATE evaluation_configurations SET tools_sha256 = ${'0'.repeat(64)}
            WHERE evaluation_id = ${evaluation.id}`.execute(t.owner),
      ).rejects.toThrow();
      await expect(
        sql`UPDATE evaluations SET approved_tasks_at_start = 5 WHERE id = ${evaluation.id}`.execute(
          t.owner,
        ),
      ).rejects.toThrow(/only the state changes/);
    });

    it('refuses half a fingerprint and tools that are not codes', async () => {
      const w = await world();
      const evaluation = await start(w, (await create(w)).id);
      const insert = (source: string | null, tools: string[] | null, sha: string | null) =>
        sql`INSERT INTO evaluation_configurations (tenant_id, evaluation_id, configuration_id,
              model, provider_type, agent_version, max_iterations, max_duration_min, source,
              allowed_tools, tools_sha256)
            SELECT tenant_id, id, 'extra', 'qwen3-8b', 'self_hosted', '1.0.0', 30, 20,
              ${source}, ${tools}, ${sha}
            FROM evaluations WHERE id = ${evaluation.id}`.execute(t.owner);
      await expect(insert('agent', ['terminal'], null)).rejects.toThrow(/fingerprint/);
      await expect(insert('robot', ['terminal'], 'a'.repeat(64))).rejects.toThrow(/source/);
      await expect(insert('agent', ['rm -rf'], 'a'.repeat(64))).rejects.toThrow(/allowed_tools/);
      await expect(insert('agent', ['terminal'], 'XYZ')).rejects.toThrow(/tools_sha256/);
    });

    it('agent_approvals: a result code for every named evaluation; still append-only', async () => {
      const w = await world();
      const evaluation = await start(w, (await create(w)).id);
      const agent = (await w.scope.agents.getByKey('openhands-qwen'))!;
      const base = {
        agent_id: agent.id,
        agent_version: agent.version,
        purpose: 'activate' as const,
        approver_id: w.users.a,
        round_at: agent.updated_at,
      };
      const row = await w.scope.agentApprovals.record({
        ...base,
        capacity: 'owner',
        evaluation_id: evaluation.id,
        evaluation_result: 'evaluation_too_few_tasks',
      });
      expect(row).toMatchObject({
        evaluation_id: evaluation.id,
        evaluation_result: 'evaluation_too_few_tasks',
      });
      expect(
        await errorCode(
          w.scope.agentApprovals.record({
            ...base,
            approver_id: w.users.viewer,
            capacity: 'person_b',
            evaluation_id: evaluation.id,
          }),
        ),
      ).toBe('invalid_value');
      expect(
        await errorCode(
          w.scope.agentApprovals.record({
            ...base,
            approver_id: w.users.viewer,
            capacity: 'person_b',
            evaluation_result: 'not a code',
          }),
        ),
      ).toBe('invalid_value');
      await expect(
        sql`UPDATE agent_approvals SET evaluation_result = 'passed' WHERE id = ${row.id}`.execute(
          t.owner,
        ),
      ).rejects.toThrow();
    });

    it('agent_approvals never names an evaluation of another tenant', async () => {
      const w = await world();
      const other = await world();
      const evaluation = await start(other, (await create(other)).id);
      const agent = (await w.scope.agents.getByKey('openhands-qwen'))!;
      expect(
        await errorCode(
          w.scope.agentApprovals.record({
            agent_id: agent.id,
            agent_version: agent.version,
            purpose: 'activate',
            capacity: 'owner',
            approver_id: w.users.a,
            round_at: agent.updated_at,
            evaluation_id: evaluation.id,
            evaluation_result: 'passed',
          }),
        ),
      ).toBe('reference_not_found');
    });
  });
});
