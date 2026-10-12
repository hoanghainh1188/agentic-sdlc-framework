// `pnpm trial:start [--passphrase-stdin]` (D-08 V08 AC2, AC3; QUESTIONS #356, #419): starts the
// trial stack again after a reboot or `pnpm trial:down`, in the order of platform/GETTING-STARTED.md
// Step 13: OpenBao (and the database), unseal with the key file's shares, the migrations, then the
// rest as `up.sh` does. The shares are decrypted in memory, given to `bootstrap.sh unseal` on
// stdin and dropped. Only for the trial's own Compose project; never on a server.
import fs from 'node:fs';
import path from 'node:path';

import type { MessageKey, MessageParams } from '@sdlc/messages';

import { envSecrets, envValue, hostPort, trialApiUrl } from './env-file.js';
import {
  decryptKeys,
  KeyFileError,
  keyFileAgeDays,
  readKeyFile,
  TRIAL_MAX_DAYS,
  TRIAL_WARNING_DAYS,
} from './keys.js';
import { SecretBag } from './secrets.js';
import { PROFILES, TrialStepError, type Exec, type ExecResult } from './up.js';

export type StartRefusal = 'production' | 'no_env' | 'not_trial';

/** Why `trial:start` must not act, or undefined. Pure. */
export function startRefusal(
  nodeEnv: string | undefined,
  envText: string | undefined,
  project: string,
): StartRefusal | undefined {
  if (nodeEnv === 'production') return 'production';
  if (envText === undefined) return 'no_env';
  return envValue(envText, 'COMPOSE_PROJECT_NAME') === project ? undefined : 'not_trial';
}

/** The catalog message of each refusal. */
export const START_REFUSAL_KEYS = {
  production: 'trial.start.refused.production',
  no_env: 'trial.start.refused.no_env',
  not_trial: 'trial.start.refused.not_trial',
} as const satisfies Record<StartRefusal, MessageKey>;

export type OpenBaoState = 'uninitialised' | 'sealed' | 'unsealed';

/** The state `bootstrap.sh status` prints, or undefined. Pure. */
export function parseStatus(stdout: string): OpenBaoState | undefined {
  const m = /OpenBao is (uninitialised|sealed|unsealed)/.exec(stdout);
  return m?.[1] as OpenBaoState | undefined;
}

/** A stop of `trial:start` with a catalog code (never a secret). */
export const START_ERROR_KEYS = {
  not_trial_container: 'trial.start.error.not_trial_container',
  not_initialised: 'trial.start.error.not_initialised',
  no_key_file: 'trial.start.error.no_key_file',
  key_file_mode: 'trial.start.error.key_file_mode',
  key_file_invalid: 'trial.start.error.key_file_invalid',
  key_file_project: 'trial.start.error.key_file_project',
  wrong_passphrase: 'trial.start.error.wrong_passphrase',
} as const satisfies Record<string, MessageKey>;

export class StartError extends Error {
  constructor(readonly code: keyof typeof START_ERROR_KEYS) {
    super(`trial:start: ${code}`);
  }
}

export interface StartDeps {
  readonly repoRoot: string;
  readonly envFile: string;
  /** The trial's Compose project, passed with `-p`. */
  readonly project: string;
  readonly keyFile: string;
  readonly exec: Exec;
  readonly progress: (key: MessageKey, params?: MessageParams) => void;
  readonly warn: (key: MessageKey, params?: MessageParams) => void;
  /** Asks the passphrase; called only when OpenBao is sealed, at most `tries` times. */
  readonly passphrase: () => Promise<string>;
  readonly tries: number;
  readonly now: Date;
}

export interface StartResult {
  readonly unsealed: 'already' | 'now';
  readonly apiUrl: string;
}

export async function trialStart(deps: StartDeps): Promise<StartResult> {
  const bag = new SecretBag();
  const deployDir = path.join(deps.repoRoot, 'platform/deploy');
  const envText = fs.readFileSync(deps.envFile, 'utf8');
  for (const value of envSecrets(envText)) bag.keep(value);

  const ok = (r: ExecResult, what: string): ExecResult => {
    if (r.status !== 0) {
      const tail = bag.redact(`${r.stderr}\n${r.stdout}`).trim().split('\n').slice(-30).join('\n');
      throw new TrialStepError(what, tail);
    }
    return r;
  };
  const run = (
    cmd: string,
    args: readonly string[],
    input = '',
    env: Record<string, string> = {},
  ) => deps.exec(cmd, args, { input, env: { SDLC_ENV_FILE: deps.envFile, ...env } });
  const compose = (...args: string[]) =>
    run('docker', [
      'compose',
      '-p',
      deps.project,
      '-f',
      path.join(deployDir, 'docker-compose.yml'),
      '--env-file',
      deps.envFile,
      ...args,
    ]);
  const bootstrap = (args: readonly string[], input = '') =>
    run(path.join(deployDir, 'openbao/bootstrap.sh'), args, input);

  const age = keyFileAgeDays(deps.keyFile, deps.now);
  if (age !== undefined && age >= TRIAL_MAX_DAYS) {
    deps.warn('trial.start.expired', { days: age, max: TRIAL_MAX_DAYS });
  } else if (age !== undefined && age >= TRIAL_WARNING_DAYS) {
    deps.warn('trial.start.ageing', { days: age, max: TRIAL_MAX_DAYS });
  }

  // 1. OpenBao and the database (GETTING-STARTED Step 13, first line).
  deps.progress('trial.start.step.openbao');
  ok(
    await compose('--profile', 'core', 'up', '-d', '--wait', 'openbao', 'postgres', 'seaweedfs'),
    'openbao',
  );
  // The container must be the trial project's own, never another stack's.
  const id = ok(await compose('ps', '-q', 'openbao'), 'compose ps').stdout.trim();
  const label = await deps.exec('docker', [
    'inspect',
    '-f',
    '{{index .Config.Labels "com.docker.compose.project"}}',
    id,
  ]);
  if (id === '' || label.status !== 0 || label.stdout.trim() !== deps.project) {
    throw new StartError('not_trial_container');
  }

  // 2. Unseal with the key file, only when OpenBao is sealed.
  const state = parseStatus(ok(await bootstrap(['status']), 'openbao:status').stdout);
  if (state === 'uninitialised' || state === undefined) throw new StartError('not_initialised');
  let unsealed: StartResult['unsealed'] = 'already';
  if (state === 'unsealed') {
    if (!fs.existsSync(deps.keyFile)) deps.warn('trial.start.no_key_file_warning');
  } else {
    deps.progress('trial.start.step.unseal');
    let bytes: Uint8Array;
    try {
      bytes = readKeyFile(deps.keyFile);
    } catch (error) {
      throw keyError(error);
    }
    const shares = await decryptWithTries(bytes, deps);
    for (const share of shares) bag.keep(share);
    try {
      ok(await bootstrap(['unseal'], `${shares.join('\n')}\n`), 'openbao:unseal');
    } finally {
      for (const share of shares) bag.drop(share);
      shares.length = 0;
    }
    unsealed = 'now';
  }

  // 3. The migrations (idempotent; Step 13).
  deps.progress('trial.start.step.migrate');
  const password = envValue(envText, 'PLATFORM_DB_PASSWORD') ?? '';
  const url = bag.keep(
    `postgres://platform:${encodeURIComponent(password)}@127.0.0.1:${hostPort(envText, 'POSTGRES_HOST_PORT', 5432)}/platform`,
  );
  ok(
    await run(
      'node',
      [path.join(deps.repoRoot, 'platform/packages/core/dist/db/migrate-cli.js'), 'latest'],
      '',
      { SDLC_DB_MIGRATION_URL: url },
    ),
    'db:migrate',
  );

  // 4. The rest, as trial:up started it.
  deps.progress('trial.start.step.up');
  ok(
    await run(path.join(deployDir, 'scripts/up.sh'), [...PROFILES], '', {
      SDLC_WAIT_TIMEOUT: '900',
    }),
    'up.sh',
  );
  return { unsealed, apiUrl: trialApiUrl(envText) };
}

function keyError(error: unknown): StartError {
  if (!(error instanceof KeyFileError)) throw error;
  switch (error.code) {
    case 'missing':
      return new StartError('no_key_file');
    case 'mode':
      return new StartError('key_file_mode');
    case 'project_mismatch':
      return new StartError('key_file_project');
    case 'wrong_passphrase':
      return new StartError('wrong_passphrase');
    default:
      return new StartError('key_file_invalid');
  }
}

/** Asks the passphrase up to `tries` times; returns a copy of the shares (the caller drops it). */
async function decryptWithTries(bytes: Uint8Array, deps: StartDeps): Promise<string[]> {
  for (let i = 1; i <= deps.tries; i += 1) {
    const passphrase = await deps.passphrase();
    try {
      const record = await decryptKeys(bytes, passphrase, deps.project);
      return [...record.shares];
    } catch (error) {
      const refusal = keyError(error);
      if (refusal.code !== 'wrong_passphrase' || i === deps.tries) throw refusal;
      deps.warn('trial.start.try_again', { left: deps.tries - i });
    }
  }
  throw new StartError('wrong_passphrase');
}
