// Seeds a tenant with a project `shop`, an AI record and one evaluation of two runs, for the
// evaluation tests on PostgreSQL (task L04).
import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';

import type { PlatformDatabase } from '../../packages/core/src/db/platform-database.js';
import { parseTenantId } from '../../packages/core/src/db/tenant-id.js';
import type { TenantScope } from '../../packages/core/src/db/tenant-scope.js';
import { startEvaluation } from '../../packages/core/src/evaluation/index.js';

export const EVAL_BASE_SHA = '7d5341d'.padEnd(40, '0');

export interface SeededEvaluation {
  readonly scope: TenantScope;
  readonly slug: string;
  readonly projectId: string;
  readonly evaluationId: string;
  readonly code: string;
  /** The evaluation runs: one task, two run numbers. */
  readonly runs: readonly string[];
}

export async function seedEvaluation(
  db: PlatformDatabase,
  options: { slug: string; budget?: string; monthly?: string | null; runsPerTask?: number },
): Promise<SeededEvaluation> {
  const tenant = await db.system.createTenant({
    slug: options.slug,
    name: options.slug,
    monthlyBudgetUsd: options.monthly === undefined ? '100' : options.monthly,
  });
  const scope = db.forTenant(parseTenantId(tenant.id));
  const project = await scope.projects.create({
    slug: 'shop',
    name: 'Shop',
    git_provider: 'github',
    repo_full_name: 'org/pilot-order-inventory',
  });
  const user = await scope.users.create({
    display_name: 'pam',
    email: `pam@${options.slug}.test`,
  });
  await scope.projectAiRecords.save(project.id, {
    aiAllowed: 'yes',
    allowedDataClasses: ['internal', 'client_restricted'],
    prodLogsAllowed: 'no',
    disclosureFormat: 'standard_note',
    confirmedAt: null,
    recordRef: null,
    updatedBy: user.id,
    expectedVersion: 0,
    actorType: 'human',
    today: '2026-10-14',
  });
  const evaluation = await startEvaluation(
    scope,
    {
      projectId: project.id,
      dataClass: 'internal',
      taskSetVersion: 1,
      configName: 'local',
      baseSha: EVAL_BASE_SHA,
      taskIds: ['feat-tax'],
      configurations: [
        {
          id: 'gpt-oss-20b',
          model: 'gpt-oss-20b',
          providerType: 'self_hosted',
          agentVersion: '1.0.0',
          maxIterations: 30,
          maxDurationMin: 20,
        },
      ],
      runsPerTask: options.runsPerTask ?? 2,
      budgetUsd: options.budget ?? '1',
      startedBy: null,
      now: new Date('2026-10-14T08:00:00.000Z'),
    },
    { policyFactory: (config, models) => createSimplePolicyEngine({ config, models }) },
  );
  const runs = (await scope.evaluationRuns.listForEvaluation(evaluation.id)).map((r) => r.id);
  return {
    scope,
    slug: options.slug,
    projectId: project.id,
    evaluationId: evaluation.id,
    code: evaluation.code,
    runs,
  };
}
