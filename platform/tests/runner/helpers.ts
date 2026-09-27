// Shared values for the runner tests (D-08 C04, ADR-M25).
import { runnerSettingsFromEnv, type RunnerSettings } from '../../apps/runner/src/index.js';

export const RUN_ID = '11111111-1111-4111-8111-111111111111';
export const TENANT_ID = '33333333-3333-4333-8333-333333333333';
export const IMAGE = `registry.internal:5000/sdlc/sandbox-node24:1@sha256:${'e'.repeat(64)}`;

export function settings(env: NodeJS.ProcessEnv = {}): RunnerSettings {
  return runnerSettingsFromEnv({
    SDLC_RUNNER_EGRESS_SERVICES: 'litellm=sdlc-litellm-1:4000,npm-proxy=sdlc-npm-proxy-1:4873',
    SDLC_RUNNER_NPM_REGISTRY: 'http://npm-proxy:4873/',
    ...env,
  });
}
