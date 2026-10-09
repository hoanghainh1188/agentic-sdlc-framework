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
  /** The trial's Compose project: passed with `-p`, so no shell variable can choose another. */
  readonly project: string;
  readonly wipe: boolean;
  /**
   * Credentials files of the trial's people, removed with `--wipe` (their tokens are dead), but
   * only when they still hold a login to the trial's API (review V02 #1): a login to another
   * platform saved there later is kept.
   */
  readonly credentialsFiles: readonly string[];
  /** The trial stack's API address (`trialApiUrl`). */
  readonly apiUrl: string;
  readonly exec: Exec;
}

/** Whether a credentials file holds a login to `apiUrl`. Pure; unreadable or other → false. */
export function isTrialLogin(text: string, apiUrl: string): boolean {
  try {
    const body = JSON.parse(text) as { api_url?: unknown };
    const strip = (url: string) => url.replace(/\/+$/, '');
    return typeof body.api_url === 'string' && strip(body.api_url) === strip(apiUrl);
  } catch {
    return false;
  }
}

export interface DownResult {
  readonly status: number | null;
  readonly stderr: string;
  /** Credentials files kept because they hold a login to another platform. */
  readonly keptLogins: readonly string[];
}

export async function trialDown(o: DownOptions): Promise<DownResult> {
  const args = [
    'compose',
    '-p',
    o.project,
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
  if (r.status !== 0 || !o.wipe) return { status: r.status, stderr: r.stderr, keptLogins: [] };
  // The TLS folder next to the env file (`openbao/tls.sh dev`), the env file, the credentials.
  fs.rmSync(path.join(path.dirname(o.envFile), 'openbao-tls'), { recursive: true, force: true });
  fs.rmSync(o.envFile, { force: true });
  const keptLogins: string[] = [];
  for (const file of o.credentialsFiles) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue; // already gone
    }
    if (isTrialLogin(text, o.apiUrl)) fs.rmSync(file, { force: true });
    else keptLogins.push(file);
  }
  return { status: 0, stderr: '', keptLogins };
}
