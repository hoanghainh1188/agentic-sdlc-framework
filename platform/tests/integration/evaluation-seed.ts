// Seeds a tenant with a project `shop`, an AI record and one evaluation of two runs, for the
// evaluation tests on PostgreSQL (task L04).
import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';
import { loadProjectConfig } from '@sdlc/config';

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
  options: {
    slug: string;
    budget?: string;
    monthly?: string | null;
    runsPerTask?: number;
    baseSha?: string;
    /** The configuration file's name and the configuration (default `local` / gpt-oss-20b). */
    configName?: string;
    configuration?: {
      id: string;
      model: string;
      agentVersion: string;
      maxIterations: number;
      maxDurationMin: number;
    };
    taskIds?: readonly string[];
    /** The project's configuration YAML (for example `sandbox.image`), stored before the start. */
    configYaml?: string;
  },
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
  if (options.configYaml !== undefined) {
    const loaded = loadProjectConfig(options.configYaml);
    if (!loaded.ok) throw new Error('test configuration refused');
    await scope.projectConfigs.save(project.id, {
      configYaml: options.configYaml,
      configHash: loaded.configHash,
      updatedBy: null,
      expectedVersion: 0,
    });
  }
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
      configName: options.configName ?? 'local',
      baseSha: options.baseSha ?? EVAL_BASE_SHA,
      taskIds: [...(options.taskIds ?? ['feat-tax'])],
      configurations: [
        {
          ...(options.configuration ?? {
            id: 'gpt-oss-20b',
            model: 'gpt-oss-20b',
            agentVersion: '1.0.0',
            maxIterations: 30,
            maxDurationMin: 20,
          }),
          providerType: 'self_hosted',
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
