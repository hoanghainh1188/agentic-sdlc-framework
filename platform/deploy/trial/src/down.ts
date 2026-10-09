// `pnpm trial:down [--wipe]` (D-08 V02 AC4): stops the trial stack; `--wipe` also removes the
// volumes of the trial's own Compose project, its env file and its TLS folder, after a
// confirmation. It never touches another Compose project (the dev stack's `sdlc_*` volumes).
import fs from 'node:fs';
import path from 'node:path';

import { envValue } from './env-file.js';
import type { Exec } from './up.js';

/** Every profile, so no service of the project is left running. */
const ALL_PROFILES = ['core', 'models', 'platform', 'sandbox', 'observability', 'backup'];

export type DownRefusal = 'no_env' | 'not_trial';

/** Why `trial:down` must not act on this env file, or undefined. Pure. */
export function downRefusal(
  envText: string | undefined,
  trialProject: string,
): DownRefusal | undefined {
  if (envText === undefined) return 'no_env';
  return envValue(envText, 'COMPOSE_PROJECT_NAME') === trialProject ? undefined : 'not_trial';
}

export interface DownOptions {
  readonly repoRoot: string;
  readonly envFile: string;
  readonly wipe: boolean;
  /** Credentials files of the trial's people, removed with `--wipe` (their tokens are dead). */
  readonly credentialsFiles: readonly string[];
  readonly exec: Exec;
}

export async function trialDown(
  o: DownOptions,
): Promise<{ status: number | null; stderr: string }> {
  const args = [
    'compose',
    '-f',
    path.join(o.repoRoot, 'platform/deploy/docker-compose.yml'),
    '--env-file',
    o.envFile,
    ...ALL_PROFILES.flatMap((p) => ['--profile', p]),
    'down',
    '--remove-orphans',
    ...(o.wipe ? ['--volumes'] : []),
  ];
  const r = await o.exec('docker', args);
  if (r.status !== 0 || !o.wipe) return { status: r.status, stderr: r.stderr };
  // The TLS folder next to the env file (`openbao/tls.sh dev`), the env file, the credentials.
  fs.rmSync(path.join(path.dirname(o.envFile), 'openbao-tls'), { recursive: true, force: true });
  fs.rmSync(o.envFile, { force: true });
  for (const file of o.credentialsFiles) fs.rmSync(file, { force: true });
  return { status: 0, stderr: '' };
}
