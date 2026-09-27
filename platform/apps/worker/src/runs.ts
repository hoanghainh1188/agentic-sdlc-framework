// What the worker needs for G4 and agent runs (task C06 session 2, design/ADR-M33 §2.5, QUESTIONS
// #112). The worker holds the Cost Controller capability: it logs in to OpenBao with a second
// AppRole, `cost-controller`, which may read the LiteLLM master key. The two AppRoles keep separate
// policies; the master key never leaves this process (the runner gets the run's virtual key as a
// single-use wrapping token).
import { LiteLLMGateway } from '@sdlc/adapter-model-litellm';
import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';
import type { GitHostAdapter, RunContractSigner, SecretWrapper } from '@sdlc/contracts';
import {
  CostController,
  parseTenantId,
  type G4Deps,
  type PlatformDatabase,
  type Registry,
  type RunDeps,
} from '@sdlc/core';
import { OpenBaoClient, optionsFromEnv, type SecretsLogger } from '@sdlc/secrets';

import type { WorkerRunSettings } from './settings.js';

/** The field of the master key entry (`kv/cost-controller/litellm-master-key`, ADR-M24). */
export const MASTER_KEY_FIELD = 'value';

export interface WorkerRuns {
  readonly g4: G4Deps;
  readonly runs: RunDeps;
  close(): Promise<void>;
}

export async function createWorkerRuns(options: {
  readonly settings: WorkerRunSettings;
  readonly env: NodeJS.ProcessEnv;
  readonly db: PlatformDatabase;
  readonly registry: Registry;
  readonly gitHost: GitHostAdapter;
  /** The worker's own OpenBao client: Transit signing and response wrapping. */
  readonly signer: RunContractSigner;
  readonly wrapper: SecretWrapper;
  readonly logger?: SecretsLogger;
}): Promise<WorkerRuns> {
  const { settings } = options;
  // Same OpenBao address and TLS settings as the worker's client; the cost-controller's files.
  const cost = new OpenBaoClient({
    ...optionsFromEnv(options.env),
    roleIdFile: settings.costRoleIdFile,
    secretIdFile: settings.costSecretIdFile,
    ...(options.logger ? { logger: options.logger } : {}),
  });
  try {
    const entry = await cost.kv().read(settings.costMasterKeyPath);
    const masterKey = entry.data[MASTER_KEY_FIELD];
    if (!masterKey) throw new Error('the LiteLLM master key entry has no value field');
    const gateway = new LiteLLMGateway({ baseUrl: settings.litellmUrl, masterKey });
    const costController = new CostController({ gateway, db: options.db });
    const g4: G4Deps = {
      gitHost: options.gitHost,
      // The policy engine over the gateway's current model list (QUESTIONS #17).
      allowedModels: async (config, dataClass) =>
        createSimplePolicyEngine({ config, models: await gateway.listModels() }).allowedModels({
          dataClass,
        }),
      tenantMonthlyBudget: async (tenantId) =>
        (await options.db.system.getTenant(parseTenantId(tenantId)))?.monthly_budget_usd ?? null,
    };
    return {
      g4,
      runs: {
        registry: options.registry,
        g4,
        signer: options.signer,
        costController,
        gitHost: options.gitHost,
        wrapper: options.wrapper,
        egressAllowlist: settings.egressAllowlist,
      },
      close: () => cost.close(),
    };
  } catch (error) {
    await cost.close();
    throw error;
  }
}
