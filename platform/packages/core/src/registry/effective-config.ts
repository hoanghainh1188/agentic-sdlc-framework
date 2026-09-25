// The project configuration in force (ADR-M18): the stored override YAML merged onto the defaults
// and validated. A project without a stored configuration uses the defaults.
import { loadProjectConfig } from '@sdlc/config';
import type { PolicyEngine, ValidatedProjectConfig } from '@sdlc/contracts';

import type { ProjectConfigRepository } from '../db/repositories/project-configs.js';
import { RegistryError } from './errors.js';

/**
 * Builds a policy engine from a validated configuration. The apps pass the adapter
 * (`createSimplePolicyEngine`); core never imports adapters (ADR-M16 section 2.5).
 */
export type PolicyFactory = (config: ValidatedProjectConfig) => PolicyEngine;

export interface RegistryDeps {
  readonly policyFactory: PolicyFactory;
  /** Registry clock: intent code year, approval expiry, binding checks. Default: `new Date()`. */
  readonly now?: () => Date;
}

export interface EffectiveConfig {
  readonly config: ValidatedProjectConfig;
  readonly configHash: string;
}

export async function loadEffectiveConfig(
  configs: ProjectConfigRepository,
  projectId: string,
): Promise<EffectiveConfig> {
  const stored = await configs.get(projectId);
  const result = loadProjectConfig(stored?.config_yaml ?? '');
  if (!result.ok) {
    throw new RegistryError(
      'config_invalid',
      `project ${projectId}: stored configuration is invalid`,
    );
  }
  if (stored && stored.config_hash !== result.configHash) {
    throw new RegistryError(
      'config_hash_mismatch',
      `project ${projectId}: stored config_hash does not match the stored configuration`,
    );
  }
  return { config: result.config, configHash: result.configHash };
}

export function clock(deps: RegistryDeps): Date {
  return deps.now ? deps.now() : new Date();
}
