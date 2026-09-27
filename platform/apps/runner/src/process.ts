// Process settings of the runner that are not about sandboxes (ADR-M25 §2.6): where the database
// is, and where the heartbeat file lives. No secret comes from the environment: the database
// password is read from OpenBao (`kv/runner/database`, AppRole `runner`), the AppRole credentials
// from files (`SDLC_OPENBAO_*`, ADR-M21).
import os from 'node:os';
import path from 'node:path';

import { RunnerError } from './errors.js';

export const PROCESS_ENV = {
  dbHost: 'SDLC_RUNNER_DB_HOST',
  dbPort: 'SDLC_RUNNER_DB_PORT',
  dbName: 'SDLC_RUNNER_DB_NAME',
  dbSecretPath: 'SDLC_RUNNER_DB_SECRET_PATH',
  heartbeatFile: 'SDLC_RUNNER_HEARTBEAT_FILE',
} as const;

/** The database role of every platform process (ADR-M09 section 2.3). */
export const DB_USER = 'platform_app';
/** Field of the KV entry written by `openbao:bootstrap runner-credentials`. */
export const DB_PASSWORD_FIELD = 'password';

export interface ProcessSettings {
  readonly db: {
    readonly host: string;
    readonly port: number;
    readonly name: string;
    /** KV path; the `runner` AppRole reads `kv/data/runner/*` only (runner.hcl). */
    readonly secretPath: string;
  };
  /** Written after each clean-up; the container health check reads its age (healthcheck.ts). */
  readonly heartbeatFile: string;
}

const HOST = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
const DB_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const SECRET_PATH = /^runner\/[A-Za-z0-9_.-]+$/;

function invalid(name: string): RunnerError {
  return new RunnerError('runner.config.invalid_setting', { name });
}

export function processSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): ProcessSettings {
  const host = env[PROCESS_ENV.dbHost] || 'postgres';
  const rawPort = env[PROCESS_ENV.dbPort] || '5432';
  const name = env[PROCESS_ENV.dbName] || 'platform';
  const secretPath = env[PROCESS_ENV.dbSecretPath] || 'runner/database';
  const heartbeatFile =
    env[PROCESS_ENV.heartbeatFile] || path.join(os.tmpdir(), 'sdlc-runner-heartbeat');
  const port = Number(rawPort);
  if (!HOST.test(host)) throw invalid(PROCESS_ENV.dbHost);
  if (!/^[0-9]{1,5}$/.test(rawPort) || port < 1 || port > 65535) throw invalid(PROCESS_ENV.dbPort);
  if (!DB_NAME.test(name)) throw invalid(PROCESS_ENV.dbName);
  if (!SECRET_PATH.test(secretPath)) throw invalid(PROCESS_ENV.dbSecretPath);
  if (!path.isAbsolute(heartbeatFile)) throw invalid(PROCESS_ENV.heartbeatFile);
  return { db: { host, port, name, secretPath }, heartbeatFile };
}
