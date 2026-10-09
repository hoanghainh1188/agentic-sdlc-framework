// The live test's throw-away project (`trial-up.test.ts`, never documented for testers). Pure, so
// its guard is unit-tested (review V02 #5): honoured only with its own env file (never the
// default one) and a trial-like project name, so no variable can point `trial:up` or
// `trial:down --wipe` at the dev stack.
import path from 'node:path';

import type { ProjectOverride } from './env-file.js';

const TRIAL_LIKE = /^(sdlc-trial|sdlctrialit)[a-z0-9-]*$/;

export function projectOverride(
  env: Readonly<Record<string, string | undefined>>,
  defaultEnvFile: string,
): ProjectOverride | undefined {
  const project = env.SDLC_TRIAL_PROJECT;
  const file = env.SDLC_TRIAL_ENV_FILE;
  if (!project || !file || path.resolve(file) === path.resolve(defaultEnvFile)) return undefined;
  if (!TRIAL_LIKE.test(project)) return undefined;
  return {
    project,
    subnet: env.SDLC_TRIAL_SUBNET ?? '',
    gateway: env.SDLC_TRIAL_GATEWAY ?? '',
    portOffset: Number(env.SDLC_TRIAL_PORT_OFFSET ?? '0'),
  };
}

/** The env file `trial:up` and `trial:down` act on: the override's, or the default one. */
export function trialEnvFile(
  env: Readonly<Record<string, string | undefined>>,
  defaultEnvFile: string,
): string {
  return projectOverride(env, defaultEnvFile)
    ? path.resolve(env.SDLC_TRIAL_ENV_FILE!)
    : defaultEnvFile;
}
