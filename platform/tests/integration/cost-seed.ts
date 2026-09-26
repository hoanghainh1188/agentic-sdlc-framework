// Seeds a tenant, project, intent, plan and a queued run with its Run Contract, for the Cost
// Controller tests (task C03): tests/integration/db/cost.test.ts and the live LiteLLM test.
import crypto from 'node:crypto';

import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';
import type { RunContractSigner } from '@sdlc/contracts';

import type { PlatformDatabase } from '../../packages/core/src/db/platform-database.js';
import { parseTenantId } from '../../packages/core/src/db/tenant-id.js';
import type { TenantScope } from '../../packages/core/src/db/tenant-scope.js';
import { Registry } from '../../packages/core/src/registry/registry.js';
import { issueRunContract } from '../../packages/core/src/run-contract/index.js';

export interface SeedOptions {
  readonly slug: string;
  /** `null`: no monthly budget. Default `'100'`. */
  readonly monthly?: string | null;
  readonly intentBudget?: string;
  readonly runBudget?: string;
  readonly models: readonly string[];
  readonly now: Date;
}

export interface SeededRun {
  readonly scope: TenantScope;
  readonly slug: string;
  readonly projectId: string;
  readonly intentId: string;
  readonly intentCode: string;
  readonly planId: string;
  readonly personA: string;
  readonly runId: string;
}

/** Signatures are not checked by these tests (C02 covers them); only the format must be right. */
const signer: RunContractSigner = {
  sign: () =>
    Promise.resolve({
      signature: `vault:v1:${crypto.randomBytes(64).toString('base64')}`,
      keyVersion: 1,
    }),
};

export async function seedRun(db: PlatformDatabase, options: SeedOptions): Promise<SeededRun> {
  const registry = new Registry({
    policyFactory: (config) => createSimplePolicyEngine({ config }),
    now: () => options.now,
  });
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
  const personA = (await scope.users.create({ display_name: 'a', email: 'a@example.com' })).id;
  const intent = await registry.createIntent(scope, {
    projectId: project.id,
    title: 'Add Japanese labels',
    createdBy: personA,
    riskTier: 'low',
    dataClass: 'internal',
    budgetUsd: options.intentBudget ?? '10',
  });
  const plan = await registry.submitPlan(scope, intent.id, {
    plannedFiles: ['apps/web/**'],
    planSha256: 'b'.repeat(64),
    actorType: 'human',
    actorId: personA,
  });
  const runId = await issueRun(scope, { intentId: intent.id, planId: plan.id, personA }, options);
  return {
    scope,
    slug: options.slug,
    projectId: project.id,
    intentId: intent.id,
    intentCode: intent.code,
    planId: plan.id,
    personA,
    runId,
  };
}

/** Issues one more queued run (the next attempt) for the same intent and plan. */
export async function issueRun(
  scope: TenantScope,
  ids: { readonly intentId: string; readonly planId: string; readonly personA: string },
  options: Pick<SeedOptions, 'runBudget' | 'models' | 'now'>,
): Promise<string> {
  const issued = await issueRunContract(
    scope,
    {
      intentId: ids.intentId,
      planId: ids.planId,
      baseSha: 'a'.repeat(40),
      agent: {
        id: '66666666-6666-4666-8666-666666666666',
        version: '1.4.0',
        instructionsSha256: 'c'.repeat(64),
        tools: ['editor'],
      },
      planTools: ['editor'],
      autonomyLevel: 'L2',
      maxBudgetUsd: options.runBudget ?? '2',
      maxIterations: 40,
      maxDurationMin: 60,
      allowedModels: [...options.models].sort(),
      egressAllowlist: ['litellm:4000'],
      triggeredBy: ids.personA,
    },
    { signer, now: () => options.now },
  );
  return issued.envelope.contract.run_id;
}
