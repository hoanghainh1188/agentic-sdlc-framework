import { formatIssue, loadProjectConfig } from '@sdlc/config';
import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';
import type { ModelRef, PolicyEngine } from '@sdlc/contracts';

/** An engine over the default configuration plus an optional project override (YAML). */
export function engineFor(overrideYaml = '', models: readonly ModelRef[] = []): PolicyEngine {
  const result = loadProjectConfig(overrideYaml);
  if (!result.ok) throw new Error(result.errors.map((e) => formatIssue(e)).join('\n'));
  return createSimplePolicyEngine({ config: result.config, models });
}
